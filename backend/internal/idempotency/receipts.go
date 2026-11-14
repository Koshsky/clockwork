package idempotency

import (
	"encoding/json"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/userctx"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

// OperationCapabilities is the handshake required before sending durable operations.
type OperationCapabilities struct {
	Protocol         int      `json:"protocol"`
	Durable          bool     `json:"durable"`
	Operations       []string `json:"operations"`
	RevisionProtocol int      `json:"revision_protocol"`
}

// OperationReceipt is an actor's immutable acknowledgement, not a current entity snapshot.
type OperationReceipt struct {
	OperationID    string          `json:"operation_id"`
	State          string          `json:"state"`
	Method         string          `json:"method,omitempty"`
	Path           string          `json:"path,omitempty"`
	RequestHash    string          `json:"request_hash,omitempty"`
	ResponseStatus int32           `json:"response_status,omitempty"`
	Response       json.RawMessage `json:"response,omitempty"        swaggertype:"object"`
	CompletedAt    *time.Time      `json:"completed_at,omitempty"`
}

// RegisterRoutes keeps operation history scoped to the authenticated actor, including administrators.
func (m *Middleware) RegisterRoutes(group *gin.RouterGroup) {
	group.GET("/operations", m.OperationCapabilities)
	group.GET("/operations/:operation_id", m.OperationReceipt)
}

// OperationCapabilities advertises the opt-in protocol without changing legacy key semantics.
//
// @Summary Durable operation capabilities
// @Description Check protocol=1, durable=true and a matching operations route/verb pattern before sending Operation-Id. Only planning/timesheet mutations are eligible; credentials, users, comments and administrative configuration are excluded. The ID is bound to the actor, method, complete request URI, exact body bytes and content type. An optional Idempotency-Key must exactly equal Operation-Id; without Operation-Id legacy TTL semantics remain unchanged. Successful durable receipts have no TTL. revision_protocol=1 enables Revision-Protocol: 1 reads and guarded mutations. Those successful replies wrap original data as data.snapshot and data._revisions (opaque aggregate tokens); guarded 204 becomes 200. Send _preconditions in the immutable JSON body plus Operation-Id and Revision-Protocol: 1. Never obtain fresh tokens separately from the edited snapshot. Strict process/project/resource/day aggregates may conservatively conflict; no field merging occurs. Existing clients without opt-in retain their original shapes and legacy writes still invalidate tokens. Non-2xx transactions roll back and remain unrecorded. Never change an existing legacy request into a durable request, or fall back to an unprotected request on an unsupported server.
// @Tags Operations
// @Security ApiKeyAuth
// @Produce json
// @Success 200 {object} response.SuccessResponse{data=OperationCapabilities,error=nil}
// @Failure 401 {object} response.ErrorResponse{data=nil}
// @Router /operations [get]
//
// Unsupported clients must never downgrade durable operations to legacy delivery.
func (m *Middleware) OperationCapabilities(c *gin.Context) {
	revisionProtocol := 0
	if m.revisions != nil {
		revisionProtocol = 1
	}
	response.OK(
		c,
		OperationCapabilities{
			Protocol:         1,
			Durable:          m.operations != nil,
			Operations:       durableOperations(),
			RevisionProtocol: revisionProtocol,
		},
	)
}

// OperationReceipt recovers a lost acknowledgement without executing its request again.
//
// @Summary Inspect an owned durable operation
// @Description Returns confirmed, in_progress or not_found for the authenticated actor only. Administrators cannot select another actor. A receipt is historical acknowledgement, not current resource access. not_found means no committed durable receipt was visible; retry only with the original Operation-Id and request. Authentication failures or unavailable storage never imply not_found. Exact byte equality is required on retries; the original response envelope is nested in response.
// @Tags Operations
// @Security ApiKeyAuth
// @Produce json
// @Param operation_id path string true "Stable operation ID, 1..128 ASCII letters/digits or ._:-, excluding dot segments"
// @Success 200 {object} response.SuccessResponse{data=OperationReceipt,error=nil}
// @Failure 400 {object} response.ErrorResponse{data=nil}
// @Failure 401 {object} response.ErrorResponse{data=nil}
// @Failure 500 {object} response.ErrorResponse{data=nil}
// @Router /operations/{operation_id} [get]
//
// Acknowledgements must remain recoverable after the original entity changes or is deleted.
func (m *Middleware) OperationReceipt(c *gin.Context) {
	id := c.Param("operation_id")
	if !validOperationID(id) || c.Request.URL.RawQuery != "" {
		response.BadRequest(c, errapi.CodeBadRequest, "invalid durable operation request")
		return
	}
	userID, err := userctx.GetUserID(c)
	if err != nil || userID <= 0 {
		response.Unauthorized(c, errapi.CodeUnauthorized, "authentication required")
		return
	}
	if m.operations == nil {
		response.InternalError(c, m.logger, "durable operations unavailable", nil)
		return
	}
	receipt, running, err := m.operations.InspectOperation(c.Request.Context(), userID, id)
	if err != nil {
		response.InternalError(c, m.logger, "durable operation lookup failed", err)
		return
	}
	result := OperationReceipt{OperationID: id, State: "not_found"}
	if running {
		result.State = "in_progress"
	} else if receipt != nil {
		result = OperationReceipt{
			OperationID: id, State: "confirmed", Method: receipt.Method, Path: receipt.Path,
			RequestHash: receipt.RequestHash, ResponseStatus: receipt.ResponseStatus,
			Response: receipt.ResponseBody, CompletedAt: &receipt.CompletedAt,
		}
	}
	response.OK(c, result)
}
