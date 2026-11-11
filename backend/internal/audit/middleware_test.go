//nolint:testpackage // tests the unexported bodyWriter and buildEvent directly
package audit

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/config"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

func TestBodyWriterCapturesStatusAndBody(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	bw := &bodyWriter{ResponseWriter: c.Writer}
	if bw.Status() != http.StatusOK {
		t.Fatalf("default status must be 200")
	}
	bw.WriteHeader(http.StatusCreated)
	if bw.Status() != http.StatusCreated {
		t.Fatalf("status must record 201")
	}
	_, _ = bw.Write([]byte(`{"ok":true}`))
	if !bytes.Equal(bw.Body(), []byte(`{"ok":true}`)) {
		t.Fatalf("body must be captured, got %s", bw.Body())
	}
	if rec.Code != http.StatusCreated {
		t.Fatalf("real writer must receive the status, got %d", rec.Code)
	}
}

func TestBuildEventExtractsActorAndID(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	cfg := config.AuditConfig{Enabled: true, URL: "http://loki:3100"}
	mw := NewMiddleware(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), cfg, nil)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	body := `{"code":"P-1","password":"secret"}`
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/project", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Set(userctx.KeyUser, userctx.UserContext{ID: 3, Email: "admin@x.ru", Preset: "admin", Admin: true})

	bw := &bodyWriter{ResponseWriter: c.Writer}
	c.Writer = bw
	bw.WriteHeader(http.StatusCreated)
	_, _ = bw.Write([]byte(`{"data":{"id":12},"error":{}}`))

	ev := mw.buildEvent(c, routeClass{entity: entProject, action: actCreate}, time.Now(), []byte(body), bw)
	if ev == nil {
		t.Fatalf("event must be built")
	}
	if ev.Entity != "project" || ev.Action != "create" {
		t.Fatalf("unexpected entity/action: %s/%s", ev.Entity, ev.Action)
	}
	if ev.ActorUserID == nil || *ev.ActorUserID != 3 {
		t.Fatalf("actor id must be extracted, got %v", ev.ActorUserID)
	}
	if ev.ActorEmail != "admin@x.ru" || ev.ActorRole != "admin" {
		t.Fatalf("actor email/role must be extracted, got %q/%q", ev.ActorEmail, ev.ActorRole)
	}
	if ev.EntityID == nil || *ev.EntityID != 12 {
		t.Fatalf("entity id must come from the response, got %v", ev.EntityID)
	}
	if ev.Status != http.StatusCreated {
		t.Fatalf("status must be 201, got %d", ev.Status)
	}
	if bytes.Contains(ev.RequestBody, []byte("secret")) {
		t.Fatalf("request body must be masked, got %s", ev.RequestBody)
	}
}

func TestBuildEventPublicAuthUsesUsername(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	cfg := config.AuditConfig{Enabled: true, URL: "http://loki:3100"}
	mw := NewMiddleware(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), cfg, nil)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	body := `{"username":"ivanov","password":"secret"}`
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewBufferString(body))
	c.Request.Header.Set("Content-Type", "application/json")

	bw := &bodyWriter{ResponseWriter: c.Writer}
	c.Writer = bw
	bw.WriteHeader(http.StatusOK)
	_, _ = bw.Write([]byte(`{"data":{"user":{"id":9}},"error":{}}`))

	ev := mw.buildEvent(c, routeClass{entity: entityAuth, action: actionLogin}, time.Now(), []byte(body), bw)
	if ev == nil {
		t.Fatalf("event must be built")
	}
	if ev.ActorEmail != "ivanov" {
		t.Fatalf("login actor must be the username, got %q", ev.ActorEmail)
	}
	if ev.ActorUserID == nil || *ev.ActorUserID != 9 {
		t.Fatalf("login actor id must come from the response user, got %v", ev.ActorUserID)
	}
	if ev.EntityID != nil {
		t.Fatalf("auth events must not carry an entity id, got %v", *ev.EntityID)
	}
	if bytes.Contains(ev.RequestBody, []byte("secret")) {
		t.Fatalf("login password must be masked, got %s", ev.RequestBody)
	}
}

func TestBuildEventAuthRefreshGetsActorFromResponse(t *testing.T) {
	t.Parallel()
	gin.SetMode(gin.TestMode)
	cfg := config.AuditConfig{Enabled: true, URL: "http://loki:3100"}
	mw := NewMiddleware(slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)), cfg, nil)

	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	// /auth/refresh has an empty request body (token lives in the cookie).
	c.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/refresh", bytes.NewBuffer(nil))

	bw := &bodyWriter{ResponseWriter: c.Writer}
	c.Writer = bw
	bw.WriteHeader(http.StatusOK)
	_, _ = bw.Write([]byte(`{"data":{"user":{"id":4,"username":"admin"}},"error":{}}`))

	ev := mw.buildEvent(c, routeClass{entity: entityAuth, action: actionRefresh}, time.Now(), nil, bw)
	if ev == nil {
		t.Fatalf("event must be built")
	}
	if ev.ActorUserID == nil || *ev.ActorUserID != 4 {
		t.Fatalf("refresh actor id must come from the response user, got %v", ev.ActorUserID)
	}
	if ev.EntityID != nil {
		t.Fatalf("auth events must not carry an entity id, got %v", *ev.EntityID)
	}
	// Empty body → no username yet (the read-side enrichment fills the login).
	if ev.ActorEmail != "" {
		t.Fatalf("refresh has no username in the request, got %q", ev.ActorEmail)
	}
}

// newCaptureMW builds a capture middleware wired to a synchronous sender
// backed by the recording stubService (I2 gate tests).
func newCaptureMW(t *testing.T) (*Middleware, *stubService) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	client := &stubService{}
	sender := newTestSender(client, true)
	cfg := config.AuditConfig{Enabled: true, URL: "http://loki:3100"}
	mw := NewMiddleware(slog.New(slog.DiscardHandler), cfg, sender)
	return mw, client
}

// TestHandlerEnqueuesCommittedMutation checks that a successful (2xx) mutation
// is captured and enqueued to the audit store (I2).
func TestHandlerEnqueuesCommittedMutation(t *testing.T) {
	t.Parallel()
	mw, client := newCaptureMW(t)

	router := gin.New()
	router.POST("/api/v1/project", mw.Handler(), func(c *gin.Context) {
		c.JSON(http.StatusCreated, gin.H{"data": gin.H{"id": 1}, "error": gin.H{}})
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/project", strings.NewReader(`{"code":"P-1"}`))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	sent := client.sent()
	if len(sent) != 1 {
		t.Fatalf("sent = %d events, want 1 for a committed 2xx mutation", len(sent))
	}
	if sent[0].Status != http.StatusCreated || sent[0].Entity != entProject || sent[0].Action != actCreate {
		t.Fatalf("unexpected event: %+v", sent[0])
	}
}

// TestHandlerSkipsFailedMutation checks that a non-2xx mutation (validation or
// conflict failure — including one later rolled back by idempotency) is never
// enqueued: the operation did not commit, so logging it would be a phantom
// record (I2).
func TestHandlerSkipsFailedMutation(t *testing.T) {
	t.Parallel()
	mw, client := newCaptureMW(t)

	router := gin.New()
	router.POST("/api/v1/project", mw.Handler(), func(c *gin.Context) {
		c.JSON(http.StatusBadRequest, gin.H{"data": nil, "error": gin.H{"message": "bad"}})
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/project", strings.NewReader(`{"code":"P-1"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if sent := client.sent(); len(sent) != 0 {
		t.Fatalf("a 4xx mutation must not be logged, got %+v", sent)
	}
}

// TestHandlerSkipsIdempotencyReplay checks that a response served as an
// idempotency replay (the Idempotency-Replayed marker set by the idempotency
// middleware) is not logged again: the mutation was already recorded when the
// key was first executed (I2).
func TestHandlerSkipsIdempotencyReplay(t *testing.T) {
	t.Parallel()
	mw, client := newCaptureMW(t)

	router := gin.New()
	router.POST("/api/v1/project", mw.Handler(), func(c *gin.Context) {
		// Mimic idempotency.replay: mark the response and answer with the
		// saved 2xx payload without executing the operation.
		c.Header("Idempotency-Replayed", "true")
		c.Data(http.StatusOK, "application/json", []byte(`{"data":{"id":1},"error":{}}`))
	})

	req := httptest.NewRequest(http.MethodPost, "/api/v1/project", strings.NewReader(`{"code":"P-1"}`))
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if sent := client.sent(); len(sent) != 0 {
		t.Fatalf("an idempotency replay must not be logged, got %+v", sent)
	}
}
