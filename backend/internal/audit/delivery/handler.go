package delivery

import (
	"log/slog"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/response"
)

// AuditHandler serves the admin audit-log query API.
type AuditHandler struct {
	logger  *slog.Logger
	service AuditQueryService
	mw      *rbac.Middleware
}

// NewAuditHandler builds the audit handler.
func NewAuditHandler(logger *slog.Logger, svc AuditQueryService, mw *rbac.Middleware) *AuditHandler {
	return &AuditHandler{logger: logger.With("component", "audit_handler"), service: svc, mw: mw}
}

// ListEvents handles the request to list audit events with filters.
//
//	@Summary		List audit events
//	@Description	Returns a paged list of audit events (all CRUD mutations + auth events).
//	@Tags			Audit
//	@Security		ApiKeyAuth
//	@Produce		json
//	@Param			limit	query		int		false	"Page size (default 50, max 500)"
//	@Param			offset	query		int		false	"Page offset"
//	@Param			user_id	query		int		false	"Filter by actor user id"
//	@Param			user	query		string	false	"Filter by actor login or full name (case-insensitive substring)"
//	@Param			entity	query		string	false	"Filter by entity (project, user, auth, ...)"
//	@Param			action	query		string	false	"Filter by action (create, update, delete, login, ...)"
//	@Param			status	query		string	false	"Filter by HTTP status group (2xx/3xx/4xx/5xx) or exact code"
//	@Param			from	query		string	false	"Lower bound (RFC3339, inclusive)"
//	@Param			to		query		string	false	"Upper bound (RFC3339, inclusive)"
//	@Param			search	query		string	false	"Substring search on path / actor email"
//	@Param			id		query		string	false	"Filter by the ID shown in the ID column (entity_id or actor_user_id)"
//	@Param			ip		query		string	false	"Filter by exact actor IP (e.g. 172.18.0.1)"
//	@Success		200		{object}	response.SuccessResponse{data=response.Page{items=[]dto.AuditEventView},error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		403		{object}	response.ErrorResponse{data=nil}
//	@Failure		502		{object}	response.ErrorResponse{data=nil}
//	@Router			/audit/events [get]
func (h *AuditHandler) ListEvents(c *gin.Context) {
	params := c.Request.URL.Query()
	items, total, limit, offset, err := h.service.List(c.Request.Context(), params)
	if err != nil {
		h.logger.ErrorContext(c.Request.Context(), "audit query failed", "error", err)
		response.InternalError(c, h.logger, "audit query failed", err)
		return
	}
	response.OK(c, response.Page{
		Items:  items,
		Total:  total,
		Limit:  limit,
		Offset: offset,
	})
}
