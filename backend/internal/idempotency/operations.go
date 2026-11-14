package idempotency

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/userctx"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

const (
	headerOperationID     = "Operation-Id"
	headerOperationStatus = "Operation-Status"
	maxOperationIDLength  = 128
	maxOperationBodyBytes = 8 << 20
)

// OperationRepo owns durable acknowledgements independently of temporary legacy keys.
type OperationRepo interface {
	ClaimOperation(context.Context, int64, string) (*sqlc.OperationReceipt, bool, pgx.Tx, error)
	InspectOperation(context.Context, int64, string) (*sqlc.OperationReceipt, bool, error)
	CompleteOperation(context.Context, sqlc.CompleteOperationParams) error
}

func validOperationID(value string) bool {
	if value == "" || value == "." || value == ".." || len(value) > maxOperationIDLength {
		return false
	}
	for _, char := range value {
		if char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' ||
			char == '-' || char == '_' || char == '.' || char == ':' {
			continue
		}
		return false
	}
	return true
}

func operationFingerprint(c *gin.Context) (string, error) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxOperationBodyBytes+1))
	if err != nil {
		return "", err
	}
	if len(body) > maxOperationBodyBytes {
		return "", errapi.BadRequest("operation request is too large")
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	// The persisted client must retry the same bytes and content type.
	contentType := c.GetHeader("Content-Type")
	encoded := binary.BigEndian.AppendUint64(nil, uint64(len(contentType)))
	encoded = append(encoded, contentType...)
	encoded = append(encoded, body...)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func (m *Middleware) handleOperation(c *gin.Context) {
	operationID := c.GetHeader(headerOperationID)
	transportKey := c.GetHeader(headerIdempotencyKey)
	if !validOperationID(operationID) || len(c.Request.Header.Values(headerOperationID)) != 1 ||
		len(c.Request.Header.Values(headerIdempotencyKey)) > 1 ||
		transportKey != "" && transportKey != operationID || !supportedOperation(c) {
		response.BadRequest(c, errapi.CodeBadRequest, "invalid durable operation request")
		c.Abort()
		return
	}
	userID, err := userctx.GetUserID(c)
	if err != nil || userID <= 0 {
		response.Unauthorized(c, errapi.CodeUnauthorized, "authentication required")
		c.Abort()
		return
	}
	if m.operations == nil {
		response.InternalError(c, m.logger, "durable operations unavailable", nil)
		c.Abort()
		return
	}
	hash, err := operationFingerprint(c)
	if err != nil {
		response.BadRequest(c, errapi.CodeBadRequest, "invalid durable operation request")
		c.Abort()
		return
	}
	request := sqlc.CompleteOperationParams{
		UserID: userID, OperationID: operationID, Method: c.Request.Method,
		Path: c.Request.URL.RequestURI(), RequestHash: hash,
	}
	m.claimOperation(c, request)
}

func supportedOperation(c *gin.Context) bool {
	parts := strings.Split(strings.TrimPrefix(c.FullPath(), "/api/v1"), "/")
	for index, part := range parts {
		if strings.HasPrefix(part, ":") {
			parts[index] = "{" + part[1:] + "}"
		}
	}
	return slices.Contains(durableOperations(), c.Request.Method+" "+strings.Join(parts, "/"))
}

// Security/admin handlers can return credentials and must never enter durable storage.
func durableOperations() []string {
	return []string{
		"POST /project",
		"PUT /project/{id}",
		"DELETE /project/{id}",
		"POST /process",
		"PUT /process/order",
		"PUT /process/{id}",
		"DELETE /process/{id}",
		"POST /task",
		"PUT /task/order",
		"PUT /task/{id}",
		"DELETE /task/{id}",
		"POST /task/{id}/dependencies",
		"PUT /task/{id}/dependencies/{dep_id}",
		"DELETE /task/{id}/dependencies/{dep_id}",
		"POST /milestone",
		"PUT /milestone/{id}",
		"DELETE /milestone/{id}",
		"POST /assignment",
		"PUT /assignment/{id}",
		"DELETE /assignment/{id}",
		"POST /resources",
		"PUT /resources/{id}",
		"DELETE /resources/{id}",
		"POST /resources/{id}/members",
		"DELETE /resources/{id}/members/{userId}",
		"POST /timesheet/states",
		"PUT /timesheet/states/{id}",
		"DELETE /timesheet/states/{id}",
		"PUT /user/{id}/days",
		"DELETE /user/{id}/days",
	}
}

func (m *Middleware) claimOperation(c *gin.Context, request sqlc.CompleteOperationParams) {
	receipt, claimed, tx, err := m.operations.ClaimOperation(c.Request.Context(), request.UserID, request.OperationID)
	if err != nil {
		response.InternalError(c, m.logger, "durable operation claim failed", err)
		c.Abort()
		return
	}
	if claimed {
		m.runOperation(c, request, tx)
		return
	}
	switch {
	case receipt == nil:
		c.Header(headerOperationStatus, "in_progress")
		c.Header("Retry-After", "1")
		response.Error(c, m.logger, errapi.Conflict("operation is in progress"))
	case receipt.Method != request.Method || receipt.Path != request.Path || receipt.RequestHash != request.RequestHash:
		c.Header(headerOperationStatus, "mismatch")
		response.Error(c, m.logger, errapi.Conflict("operation id was already used for another request"))
	default:
		c.Header(headerOperationStatus, "confirmed")
		replay(c, int(receipt.ResponseStatus), receipt.ResponseBody)
	}
	c.Abort()
}

func (m *Middleware) runOperation(c *gin.Context, request sqlc.CompleteOperationParams, tx pgx.Tx) {
	original := c.Writer
	writer := &captureWriter{ResponseWriter: original}
	c.Writer = writer
	c.Request = c.Request.WithContext(database.WithTx(c.Request.Context(), tx))
	defer func() {
		c.Writer = original
		_ = tx.Rollback(context.WithoutCancel(c.Request.Context()))
	}()
	c.Next()
	m.finishOperation(c, writer, request, tx)
}

func (m *Middleware) finishOperation(
	c *gin.Context, writer *captureWriter, request sqlc.CompleteOperationParams, tx pgx.Tx,
) {
	status := writer.status
	if status == 0 {
		status = http.StatusOK
	}
	if status < http.StatusOK || status >= http.StatusMultipleChoices {
		_ = tx.Rollback(context.WithoutCancel(c.Request.Context()))
		c.Header(headerOperationStatus, "unrecorded")
		writer.flush()
		return
	}
	request.ResponseStatus = int32(status)
	request.ResponseBody = json.RawMessage(writer.body)
	if err := m.operations.CompleteOperation(c.Request.Context(), request); err != nil {
		m.operationFailure(c, writer, err)
		return
	}
	if err := tx.Commit(c.Request.Context()); err != nil {
		m.operationFailure(c, writer, err)
		return
	}
	c.Header(headerOperationStatus, "confirmed")
	writer.flush()
}

func (m *Middleware) operationFailure(c *gin.Context, writer *captureWriter, err error) {
	c.Header(headerOperationStatus, "unknown")
	writer.reset()
	response.InternalError(c, m.logger, "durable operation outcome unknown", err)
	writer.flush()
}
