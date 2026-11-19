package idempotency

import (
	"context"
	"errors"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

func (m *Middleware) record(c *gin.Context, stage diagnostics.Stage, outcome diagnostics.Outcome, err error) {
	diagnostics.Record(c.Request.Context(), m.logger, stage, outcome, err)
}

func (m *Middleware) observeRollback(ctx context.Context, err error, recorded *bool) {
	if errors.Is(err, pgx.ErrTxClosed) || err == nil && *recorded {
		return
	}
	outcome := diagnostics.RolledBack
	if err != nil {
		outcome = diagnostics.Unknown
	}
	if err == nil {
		*recorded = true
	}
	diagnostics.Record(ctx, m.logger, diagnostics.Rollback, outcome, err)
}

func rejectedOutcome(status int) diagnostics.Outcome {
	if status == http.StatusConflict {
		return diagnostics.Conflict
	}
	if status >= http.StatusInternalServerError {
		return diagnostics.Failed
	}
	return diagnostics.Rejected
}
