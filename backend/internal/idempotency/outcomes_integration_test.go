//go:build integration

package idempotency_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/diagnostics"
	idem "github.com/Koshsky/erp-backend/internal/idempotency"
)

func TestDurableDiagnosticsLostResponseReceiptReplayAndRollback(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	counts := diagnostics.NewOutcomes()
	wrap := func(router *gin.Engine) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			router.ServeHTTP(w, r.WithContext(diagnostics.WithOutcomes(r.Context(), counts)))
		})
	}
	router := wrap(f.router)
	request := func(id string) *http.Request {
		return operationRequest(http.MethodPost, "/api/v1/task", id, `{"name":"canary-title"}`, "")
	}
	server := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, r *http.Request) { router.ServeHTTP(lostOperationResponse{w}, r) },
		),
	)
	t.Cleanup(server.Close)
	first, err := http.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		server.URL+"/api/v1/task",
		strings.NewReader(`{"name":"canary-title"}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	first.Header.Set("Operation-Id", "lost-response")
	first.Header.Set("Content-Type", "application/json")
	reply, err := (&http.Client{Timeout: 3 * time.Second}).Do(first)
	if reply != nil {
		reply.Body.Close()
	}
	if err == nil {
		t.Fatal("first response was not lost")
	}

	receipt := operationCall(router, operationRequest(http.MethodGet, "/api/v1/operations/lost-response", "", "", ""))
	if receipt.Code != 200 {
		t.Fatal("receipt not recoverable")
	}
	replayed := operationCall(router, request("lost-response"))
	if replayed.Code != 201 || f.count("business_rows") != 1 {
		t.Fatal("retry repeated the mutation")
	}
	if countOutcome(counts, diagnostics.Durable, diagnostics.Accepted) != 1 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Replayed) != 1 ||
		countOutcome(counts, diagnostics.Receipt, diagnostics.Confirmed) != 1 {
		t.Fatalf("lost-response recovery inflated success: %v", counts.Snapshot())
	}
	// Roll back a real write on denial/conflict; no accepted receipt may appear.
	for _, status := range []int{403, 409} {
		denied := wrap(f.routes(func(c *gin.Context) {
			tx, _ := database.TxFrom(c.Request.Context())
			if _, err := tx.Exec(
				c.Request.Context(),
				"INSERT INTO business_rows(name) VALUES('rolled-back')",
			); err != nil {
				t.Error(err)
			}
			c.Status(status)
		}))
		response := operationCall(denied, request(map[int]string{403: "denial", 409: "conflict"}[status]))
		if response.Code != status || f.count("business_rows") != 1 {
			t.Fatal("diagnostics changed transactional rejection")
		}
	}
	if countOutcome(counts, diagnostics.Rollback, diagnostics.RolledBack) != 2 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Rejected) != 1 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Conflict) != 1 {
		t.Fatalf("rejection/rollback outcomes wrong: %v", counts.Snapshot())
	}
}

func TestRevisionDiagnosticDoesNotExposeConflictBeforePermissionDenial(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	counts := diagnostics.NewOutcomes()
	mw := idem.New(f.repo, nil, nil)
	router := gin.New()
	group := router.Group("/api/v1")
	group.Use(func(c *gin.Context) {
		c.Request = c.Request.WithContext(diagnostics.WithOutcomes(c.Request.Context(), counts))
		c.Next()
	})
	group.Use(mw.RevisionHandler())
	group.PUT("/task/:id", func(c *gin.Context) { c.Status(http.StatusForbidden) })
	request := operationRequest(
		http.MethodPut,
		"/api/v1/task/1",
		"revision-denied",
		`{"_preconditions":{"process:1":"stale"}}`,
		"",
	)
	request.Header.Set("Revision-Protocol", "1")
	// Revision writes require the existing durable transaction, not a diagnostic transaction.
	tx, err := f.pool.Begin(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	request = request.WithContext(database.WithTx(request.Context(), tx))
	response := operationCall(router, request)
	if response.Code != 403 || countOutcome(counts, diagnostics.Revision, diagnostics.Conflict) != 0 {
		t.Fatal("diagnostics became a revision/RBAC oracle")
	}
}

func TestDurableDiagnosticCommitFailureRemainsUnknownUntilSafeRetry(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	counts := diagnostics.NewOutcomes()
	_, err := f.pool.Exec(
		t.Context(),
		"CREATE TABLE allowed_diagnostic_actors(id bigint PRIMARY KEY); ALTER TABLE operation_receipts ADD CONSTRAINT diagnostic_commit FOREIGN KEY(user_id) REFERENCES allowed_diagnostic_actors(id) DEFERRABLE INITIALLY DEFERRED",
	)
	if err != nil {
		t.Fatal(err)
	}
	call := func() *httptest.ResponseRecorder {
		req := operationRequest(
			http.MethodPost,
			"/api/v1/task",
			"failed-diagnostic-commit",
			`{"name":"canary-body"}`,
			"",
		)
		req = req.WithContext(diagnostics.WithOutcomes(req.Context(), counts))
		return operationCall(f.router, req)
	}
	first := call()
	if first.Code != 500 || first.Header().Get("Operation-Status") != "unknown" || f.count("business_rows") != 0 ||
		f.count("operation_receipts") != 0 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Accepted) != 0 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Unknown) != 1 {
		t.Fatal("diagnostics invented confirmation after a failed commit")
	}
	if _, err = f.pool.Exec(t.Context(), "INSERT INTO allowed_diagnostic_actors VALUES(7)"); err != nil {
		t.Fatal(err)
	}
	second := call()
	if second.Code != 201 || f.count("business_rows") != 1 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Accepted) != 1 ||
		countOutcome(counts, diagnostics.Durable, diagnostics.Unknown) != 1 {
		t.Fatal("retry changed transaction or outcome counts")
	}
}
