// Package idempotency provides an Idempotency-Key mechanism that makes create
// endpoints replay-safe: a client sends an Idempotency-Key header; the server
// atomically claims the key and on a repeat with the same key returns the saved
// response instead of executing the operation again (no duplicate records).
//
// Transactional guarantee: for a claimed key the middleware runs the operation
// inside one request-scoped transaction (see internal/database.WithTx) together
// with the key completion, and delivers the response only after the
// transaction commits. A crash or a failed request rolls the business rows and
// the key back together, so a retry re-executes cleanly — there is no window
// where the operation succeeded but the key was never completed (a "2xx sent,
// key not completed" crash would otherwise duplicate the create on replay).
package idempotency

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository"
	"github.com/Koshsky/erp-backend/internal/response"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

// HTTP header the client uses to mark an idempotent request.
const headerIdempotencyKey = "Idempotency-Key"

// maxKeyLen — upper bound on key length (protects the PK from junk/huge values).
const maxKeyLen = 256

// keyTTL — how long an idempotency key lives before auto-cleanup.
const keyTTL = 24 * time.Hour

// cleanupInterval — how often expired keys are cleaned up.
const cleanupInterval = 1 * time.Hour

// Repo is the storage the middleware uses to claim, complete and release
// idempotency keys. Kept as an interface so it can be faked in unit tests.
//
// Claim returns the open request-scoped transaction (pgx.Tx) together with the
// outcome; the middleware commits it after a successful completion or rolls it
// back otherwise.
type Repo interface {
	Claim(
		ctx context.Context,
		key string,
		userID int64,
		method, path string,
		expiresAt time.Time,
	) (*repository.StoredResult, bool, pgx.Tx, error)
	Complete(
		ctx context.Context,
		key string,
		userID int64,
		method, path string,
		status int,
		body json.RawMessage,
	) error
	Release(ctx context.Context, key string, userID int64, method, path string) error
	DeleteExpired(ctx context.Context) error
}

// Middleware implements the Idempotency-Key mechanism for a route.
type Middleware struct {
	repo   Repo
	logger *slog.Logger
	tracer *tracingpkg.Tracer

	cleanupOnce sync.Once
}

// New builds the idempotency middleware.
func New(
	repo Repo,
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
) *Middleware {
	if logger == nil {
		logger = slog.Default()
	}
	if tracer == nil {
		tracer = tracingpkg.New(nil)
	}
	return &Middleware{repo: repo, logger: logger, tracer: tracer}
}

// Handler wraps the route handler with the idempotency logic.
func (m *Middleware) Handler() gin.HandlerFunc {
	m.startCleanup()
	return func(c *gin.Context) {
		key := c.GetHeader(headerIdempotencyKey)
		if key == "" || len(key) > maxKeyLen {
			// No key (or an unreasonably long one) — a plain non-idempotent request.
			c.Next()
			return
		}

		userID, err := userctx.GetUserID(c)
		if err != nil {
			// No authenticated user — there is nothing to bind the key to;
			// proceed without the idempotency guarantee.
			c.Next()
			return
		}

		ctx, end := m.tracer.Start(c.Request.Context(), "middleware.idempotency")
		c.Request = c.Request.WithContext(ctx)
		defer end(nil)

		result, claimed, tx, err := m.repo.Claim(
			ctx,
			key,
			userID,
			c.Request.Method,
			c.Request.URL.Path,
			time.Now().Add(keyTTL),
		)
		if err != nil {
			m.logger.Error("idempotency claim failed", "error", err, "key", key)
			response.InternalError(c, m.logger, "idempotency storage failure", err)
			c.Abort()
			return
		}

		if !claimed {
			m.replayOrConflict(c, result, key)
			return
		}

		m.runClaimed(ctx, c, key, userID, tx)
	}
}

// replayOrConflict answers the Claim outcomes that did not win the key: a
// finished key is replayed from its saved response; a key still in flight
// yields a conflict — never a re-execution.
func (m *Middleware) replayOrConflict(c *gin.Context, result *repository.StoredResult, key string) {
	if result == nil {
		// The key exists but the first request is still running — do not duplicate.
		response.Error(c, m.logger, errapi.Conflict("request already in progress"))
		c.Abort()
		return
	}
	// Replay with the same key: return the saved response.
	m.logger.Debug("idempotency replay", "key", key)
	replay(c, result.Status, result.Body)
	// Returning without c.Next() in gin does not stop the handler chain,
	// so we abort it explicitly to avoid executing the operation again.
	c.Abort()
}

// runClaimed executes the operation inside the request-scoped transaction and
// captures the response: nothing reaches the client until the transaction
// (business writes + key completion) commits.
func (m *Middleware) runClaimed(ctx context.Context, c *gin.Context, key string, userID int64, tx pgx.Tx) {
	txCtx := database.WithTx(ctx, tx)
	c.Request = c.Request.WithContext(txCtx)
	original := c.Writer
	cw := &captureWriter{ResponseWriter: original}
	c.Writer = cw

	committed := false
	// Restore the real writer before unwinding so gin.Recovery()/aborts reach
	// the client even when a panic skips c.Next()'s normal return; roll back
	// the transaction unless the caller already committed it.
	defer func() {
		if c.Writer != original {
			c.Writer = original
		}
		if !committed {
			// context.Background: the rollback must reach the server even
			// when the request context is already canceled.
			if rerr := tx.Rollback(context.Background()); rerr != nil && !errors.Is(rerr, pgx.ErrTxClosed) {
				m.logger.ErrorContext(ctx, "idempotency transaction rollback failed", "error", rerr, "key", key)
			}
		}
	}()

	c.Next()

	m.finalize(c, cw, key, userID, c.Request.Method, c.Request.URL.Path, tx, &committed)
	c.Writer = original
}

// finalize commits or rolls back the request transaction and delivers the
// buffered response:
//
//   - 2xx — complete the key inside the transaction, commit, flush the response:
//     the client sees success only after business rows and the key are durable.
//   - anything else (4xx/5xx, rate-limit 429) — roll the transaction back
//     (undoing the request's partial writes), release the key so a retry
//     re-executes, then flush the error response.
func (m *Middleware) finalize(
	c *gin.Context,
	cw *captureWriter,
	key string,
	userID int64,
	method, path string,
	tx pgx.Tx,
	committed *bool,
) {
	ctx := c.Request.Context()
	status := cw.status
	if status == 0 {
		status = http.StatusOK
	}
	if status >= http.StatusOK && status < http.StatusMultipleChoices {
		// Complete/Commit failure — commit ambiguity: the business writes are
		// already rolled back (deferred in runClaimed), so atomicity holds, but
		// the key row may or may not have been updated before the failure.
		// Deliberately do NOT release the key here: it stays in-flight, so a
		// retry gets a 409 Conflict until the claim lease (repository
		// claimLease, 2 min) expires and the key is reclaimed — re-executing an
		// operation whose outcome is unknown could duplicate it.
		if cerr := m.repo.Complete(ctx, key, userID, method, path, status, json.RawMessage(cw.body)); cerr != nil {
			m.logger.ErrorContext(ctx, "idempotency complete failed", "error", cerr, "key", key)
			cw.reset()
			response.InternalError(c, m.logger, "idempotency storage failure", cerr)
			cw.flush()
			return
		}
		if cerr := tx.Commit(ctx); cerr != nil {
			m.logger.ErrorContext(ctx, "idempotency commit failed", "error", cerr, "key", key)
			cw.reset()
			response.InternalError(c, m.logger, "idempotency commit failed", cerr)
			cw.flush()
			return
		}
		*committed = true
		// Deliver the 2xx only now: the response was written by the handler,
		// but the client sees it only once the transaction is durable.
		cw.flush()
		return
	}
	// Non-2xx: undo the request's writes and release the key for a retry.
	if rerr := tx.Rollback(ctx); rerr != nil && !errors.Is(rerr, pgx.ErrTxClosed) {
		m.logger.ErrorContext(ctx, "idempotency transaction rollback failed", "error", rerr, "key", key)
	}
	if rerr := m.repo.Release(context.WithoutCancel(ctx), key, userID, method, path); rerr != nil {
		m.logger.ErrorContext(ctx, "idempotency release failed", "error", rerr, "key", key)
	}
	cw.flush()
}

// startCleanup starts background cleanup of expired keys for the lifetime of
// the process (similar to the background rate-limit bucket cleanup).
func (m *Middleware) startCleanup() {
	m.cleanupOnce.Do(func() {
		go func() {
			for {
				time.Sleep(cleanupInterval)
				if err := m.repo.DeleteExpired(context.Background()); err != nil {
					m.logger.Error("idempotency cleanup failed", "error", err)
				}
			}
		}()
	})
}

// replay sends the saved response to the client. All application responses are
// JSON ({data,error}), so the Content-Type is fixed; Idempotency-Replayed is a
// diagnostic marker for the client.
func replay(c *gin.Context, status int, body json.RawMessage) {
	c.Header("Content-Type", "application/json")
	c.Header("Idempotency-Replayed", "true")
	if len(body) == 0 {
		c.Status(status)
		return
	}
	c.Data(status, "application/json", body)
}

// captureWriter buffers the status and body of the current request's response.
// Nothing reaches the client until flush() runs after the request transaction
// is committed or rolled back, so a success response is never sent before the
// business writes and the idempotency key are durable.
type captureWriter struct {
	gin.ResponseWriter

	status int
	body   []byte
}

func (w *captureWriter) WriteHeader(code int) {
	w.status = code
	// Deliberately not forwarded: the status line is part of the buffered
	// response delivered by flush().
}

func (w *captureWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.body = append(w.body, b...)
	return len(b), nil
}

func (w *captureWriter) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// WriteHeaderNow is a no-op: the buffered response is delivered by flush().
func (w *captureWriter) WriteHeaderNow() {}

// Status returns the recorded response status.
func (w *captureWriter) Status() int {
	return w.status
}

// reset clears the buffered status and body. Used to drop an already-buffered
// 2xx body before writing a failure response, so the error envelope is the
// only JSON document the client receives instead of being appended after the
// success body (which would produce two concatenated JSON documents).
func (w *captureWriter) reset() {
	w.status = 0
	w.body = nil
}

// Written reports whether a response (status or body) has been captured.
func (w *captureWriter) Written() bool {
	return w.status != 0 || len(w.body) > 0
}

// Size returns the length of the buffered response body.
func (w *captureWriter) Size() int {
	return len(w.body)
}

// flush delivers the buffered response to the underlying writer. It is the
// only point where the response leaves the middleware; call it after the
// request transaction is committed (2xx) or rolled back (failure).
func (w *captureWriter) flush() {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	w.ResponseWriter.WriteHeader(w.status)
	if len(w.body) > 0 {
		_, _ = w.ResponseWriter.Write(w.body)
	}
}
