package idempotency

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/database"
	internalerrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/response"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

const (
	headerRevisionProtocol   = "Revision-Protocol"
	maxRevisionPreconditions = 2048
)

// RevisionRepo joins guarded writes and consistent reads to the existing transaction boundary.
type RevisionRepo interface {
	BeginRevisionSnapshot(context.Context) (pgx.Tx, error)
	LockRevisionWriters(context.Context) error
	RevisionTokens(context.Context, []string) (map[string]string, error)
	RevisionParents(context.Context, string, int64) ([]string, error)
}

// RevisionSnapshot preserves every legacy data shape inside an explicit opt-in wrapper.
type RevisionSnapshot struct {
	Snapshot  json.RawMessage   `json:"snapshot"   swaggertype:"object"`
	Revisions map[string]string `json:"_revisions"`
}

// RevisionHandler runs after durable replay, so accepted operations never become new conflicts.
func (m *Middleware) RevisionHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method == http.MethodGet {
			if c.GetHeader(headerRevisionProtocol) != "" && revisionReadKind(c) != "" {
				m.revisionRead(c)
			}
			return
		}
		if !supportedOperation(c) {
			return
		}
		conditions, opted, err := revisionConditions(c)
		if !opted {
			return
		}
		if err != nil || !validRevisionHeader(c) || c.GetHeader(headerOperationID) == "" {
			m.revisionInvalid(c)
			return
		}
		if m.revisions == nil {
			m.revisionFailure(c, nil)
			return
		}
		if _, ok := database.TxFrom(c.Request.Context()); !ok {
			m.revisionFailure(c, nil)
			return
		}
		m.revisionWrite(c, conditions)
	}
}

func validRevisionHeader(c *gin.Context) bool {
	return len(c.Request.Header.Values(headerRevisionProtocol)) == 1 && c.GetHeader(headerRevisionProtocol) == "1"
}

func revisionConditions(c *gin.Context) (map[string]string, bool, error) {
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, maxOperationBodyBytes+1))
	if err != nil {
		return nil, true, err
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	var fields map[string]json.RawMessage
	decodeErr := json.Unmarshal(body, &fields)
	raw, present := fields["_preconditions"]
	opted := present || len(c.Request.Header.Values(headerRevisionProtocol)) != 0
	if !opted {
		return nil, false, nil
	}
	var conditions map[string]string
	if decodeErr != nil || !present || len(body) > maxOperationBodyBytes || json.Unmarshal(raw, &conditions) != nil ||
		conditions == nil ||
		len(conditions) > maxRevisionPreconditions {
		return nil, true, internalerrors.ErrRevisionRequestInvalid
	}
	for key, token := range conditions {
		if !validRevisionKey(key) || token == "" || len(token) > maxOperationIDLength ||
			strings.ContainsAny(token, "\r\n\x00") {
			return nil, true, internalerrors.ErrRevisionRequestInvalid
		}
	}
	return conditions, true, nil
}

func (m *Middleware) revisionInvalid(c *gin.Context) {
	c.Header("Revision-Status", "invalid")
	response.BadRequest(c, errapi.CodeBadRequest, "invalid revision preconditions")
	c.Abort()
}

func (m *Middleware) revisionFailure(c *gin.Context, err error) {
	response.InternalError(c, m.logger, "revision storage unavailable", err)
	c.Abort()
}

func (m *Middleware) revisionRead(c *gin.Context) {
	if !validRevisionHeader(c) {
		m.revisionInvalid(c)
		return
	}
	if m.revisions == nil {
		m.revisionFailure(c, nil)
		return
	}
	tx, err := m.revisions.BeginRevisionSnapshot(c.Request.Context())
	if err != nil {
		m.revisionFailure(c, err)
		return
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(c.Request.Context())) }()
	c.Request = c.Request.WithContext(database.WithTx(c.Request.Context(), tx))
	original := c.Writer
	writer := &captureWriter{ResponseWriter: original}
	c.Writer = writer
	defer func() { c.Writer = original }()
	c.Next()
	if successfulRevision(writer) {
		if err = m.wrapRevisionSnapshot(c, writer, nil); err != nil {
			writer.reset()
			m.revisionFailure(c, err)
		}
	}
	writer.flush()
}

func successfulRevision(writer *captureWriter) bool {
	status := writer.Status()
	return status == 0 || status >= http.StatusOK && status < http.StatusMultipleChoices
}

func (m *Middleware) revisionWrite(c *gin.Context, conditions map[string]string) {
	if err := m.revisions.LockRevisionWriters(c.Request.Context()); err != nil {
		m.revisionFailure(c, err)
		return
	}
	keys, err := m.revisionWriteKeys(c)
	if err != nil {
		m.revisionFailure(c, err)
		return
	}
	tokens, err := m.revisions.RevisionTokens(c.Request.Context(), keys)
	if err != nil {
		m.revisionFailure(c, err)
		return
	}
	mismatch := slices.ContainsFunc(
		keys,
		func(key string) bool { return tokens[key] == "" || conditions[key] != tokens[key] },
	)
	original := c.Writer
	writer := &captureWriter{ResponseWriter: original}
	c.Writer = writer
	defer func() { c.Writer = original }()
	// The real handler performs RBAC first; a denied request must not become a revision oracle.
	c.Next()
	if successfulRevision(writer) {
		if mismatch {
			writer.reset()
			c.Header("Revision-Status", "conflict")
			response.Error(c, m.logger, errapi.Conflict("data changed; reload before retrying"))
		} else if err = m.wrapRevisionSnapshot(c, writer, keys); err != nil {
			writer.reset()
			m.revisionFailure(c, err)
		}
	}
	writer.flush()
}

func (m *Middleware) wrapRevisionSnapshot(c *gin.Context, writer *captureWriter, keys []string) error {
	snapshot := json.RawMessage(`{}`)
	if len(writer.body) != 0 {
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(writer.body, &envelope); err != nil {
			return err
		}
		if len(envelope.Data) != 0 {
			snapshot = envelope.Data
		}
	}
	discovered, err := m.revisionSnapshotKeys(c, snapshot)
	if err != nil {
		return err
	}
	keys = revisionUnique(append(keys, discovered...))
	tokens, err := m.revisions.RevisionTokens(c.Request.Context(), keys)
	if err != nil {
		return err
	}
	if len(tokens) != len(keys) {
		return internalerrors.ErrRevisionTokenMissing
	}
	body, err := json.Marshal(response.Response{Data: RevisionSnapshot{Snapshot: snapshot, Revisions: tokens}})
	if err != nil {
		return err
	}
	writer.body = body
	if writer.Status() == http.StatusNoContent {
		writer.status = http.StatusOK
	}
	c.Header(headerRevisionProtocol, "1")
	return nil
}
