package audit

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// Middleware captures every CRUD mutation and auth event (non-GET requests on
// classified routes), masks sensitive request/response data, and enqueues the
// event to the auditlog service.
type Middleware struct {
	logger *slog.Logger
	cfg    config.AuditConfig
	sender *Sender
}

// NewMiddleware builds the audit capture middleware.
func NewMiddleware(logger *slog.Logger, cfg config.AuditConfig, sender *Sender) *Middleware {
	return &Middleware{logger: logger.With("component", "audit_middleware"), cfg: cfg, sender: sender}
}

// Start starts the async sender worker (no-op in sync mode).
func (m *Middleware) Start() {
	// The sender starts its worker in NewSender; nothing else to do.
}

// Stop flushes buffered events and stops the sender.
func (m *Middleware) Stop(ctx context.Context) {
	m.sender.Stop(ctx)
}

// Handler returns the capture middleware. When audit is disabled it is a
// transparent no-op.
func (m *Middleware) Handler() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !m.cfg.Enabled || !isMutation(c.Request.Method) {
			c.Next()
			return
		}
		fullPath := c.FullPath()
		rc, ok := classify(c.Request.Method, fullPath)
		if !ok {
			c.Next()
			return
		}

		start := time.Now()
		// Buffer and restore the request body for the downstream handlers.
		var reqBody []byte
		if c.Request.Body != nil {
			reqBody, _ = io.ReadAll(c.Request.Body)
			c.Request.Body = io.NopCloser(bytes.NewReader(reqBody))
		}

		// Capture the response status and body.
		bw := &bodyWriter{ResponseWriter: c.Writer}
		c.Writer = bw

		c.Next()

		// Only mutations that actually committed (2xx) enter the audit trail: a
		// 4xx/5xx response means the operation did not take effect (validation
		// failure, conflict, or the idempotency middleware rolling the request
		// transaction back), so recording it would log a phantom mutation. An
		// idempotency replay answers with the saved response of a previously
		// executed request and would duplicate the same event.
		if !isSuccessStatus(bw.Status()) || isIdempotencyReplay(c) {
			return
		}

		// Never log the audit query API itself (GET is already excluded by the
		// method filter; this guards any future audit write routes).
		ev := m.buildEvent(c, rc, start, reqBody, bw)
		if ev != nil {
			m.sender.Enqueue(*ev)
		}
	}
}

// headerIdempotencyReplayed is the response marker the idempotency middleware
// sets when it answers a request from the saved result of a finished key
// instead of re-executing the operation.
const headerIdempotencyReplayed = "Idempotency-Replayed"

// isSuccessStatus reports whether the captured status is a 2xx — the only
// responses that correspond to a committed mutation.
func isSuccessStatus(status int) bool {
	return status >= http.StatusOK && status < http.StatusMultipleChoices
}

// isIdempotencyReplay reports whether the response was served as an idempotency
// replay: the middleware reads the Idempotency-Replayed marker off the response
// headers (set by the idempotency middleware when it replays a finished key).
func isIdempotencyReplay(c *gin.Context) bool {
	return c.Writer.Header().Get(headerIdempotencyReplayed) == "true"
}

// buildEvent assembles the audit event from the captured request.
func (m *Middleware) buildEvent(
	c *gin.Context,
	rc routeClass,
	start time.Time,
	reqBody []byte,
	bw *bodyWriter,
) *Event {
	ev := &Event{
		TS:         nowRFC3339(),
		Entity:     rc.entity,
		Action:     rc.action,
		Method:     c.Request.Method,
		Path:       c.Request.URL.Path,
		Status:     bw.Status(),
		DurationMS: durationMS(time.Since(start)),
		ActorIP:    c.ClientIP(),
		// Security-relevant events take the priority path (M2): even with the
		// main buffer full, the login/logout trail is enqueued and drained
		// ahead of regular events — never sent on the request goroutine.
		Critical: isCriticalAction(rc.action),
	}

	if u, err := userctx.GetUser(c); err == nil {
		ev.ActorUserID = &u.ID
		ev.ActorEmail = u.Email
		ev.ActorRole = u.Preset
	} else if rc.entity == entityAuth {
		// Public auth events (login): no authenticated user yet — label the
		// actor by the submitted username (password is masked).
		ev.ActorEmail = usernameFromBody(reqBody)
	}

	if rc.idParam != "" {
		if id := paramID64(c, rc.idParam); id != nil {
			ev.EntityID = id
		}
	}
	if ev.EntityID == nil {
		// Creates return the new id in the response body. For auth events the
		// response user id identifies the authenticated user (the actor):
		// login/refresh return an AuthResponse with data.user.id.
		id := extractEntityID(bw.Body())
		if rc.entity == entityAuth {
			ev.ActorUserID = id
		} else {
			ev.EntityID = id
		}
	}

	if len(reqBody) > 0 {
		ev.RequestBody = MaskJSON(reqBody)
	}
	if body := bw.Body(); len(body) > 0 {
		ev.ResponseBody = MaskJSON(body)
	}
	return ev
}

// isMutation reports whether the method changes server state.
func isMutation(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodDelete:
		return true
	default:
		return false
	}
}

// paramID64 parses a gin URL param as int64 (nil when missing/unparseable).
func paramID64(c *gin.Context, param string) *int64 {
	raw := c.Param(param)
	if raw == "" {
		return nil
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id < 1 {
		return nil
	}
	return &id
}

// bodyWriter captures the response status and body while writing through to
// the real writer.
type bodyWriter struct {
	gin.ResponseWriter

	buf    bytes.Buffer
	status int
}

// Write records the payload and forwards it.
func (w *bodyWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.buf.Write(b)
	return w.ResponseWriter.Write(b)
}

// WriteHeader records the status and forwards it.
func (w *bodyWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// Status returns the recorded response status (200 when never written).
func (w *bodyWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

// Body returns the captured response body.
func (w *bodyWriter) Body() []byte {
	return w.buf.Bytes()
}
