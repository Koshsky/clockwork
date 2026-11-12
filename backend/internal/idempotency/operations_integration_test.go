//go:build integration

package idempotency_test

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	idem "github.com/Koshsky/erp-backend/internal/idempotency"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/migrations"
)

const operationTestTimeout = 10 * time.Second

type operationFixture struct {
	t      *testing.T
	pool   *pgxpool.Pool
	repo   *repository.IdempotencyRepository
	router *gin.Engine
}

func newOperationFixture(t *testing.T) *operationFixture {
	t.Helper()
	url := os.Getenv("OPERATION_TEST_DATABASE_URL")
	if url == "" {
		t.Skip("set OPERATION_TEST_DATABASE_URL to an isolated erp_operations_ database")
	}
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(cfg.ConnConfig.Database, "erp_operations_") {
		t.Fatal("refusing a non-test database")
	}
	base, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(base.Close)
	schema := pgx.Identifier{"operations_" + strings.ToLower(rand.Text())}.Sanitize()
	if _, err = base.Exec(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, dropErr := base.Exec(context.Background(), "DROP SCHEMA "+schema+" CASCADE")
		if dropErr != nil {
			t.Error(dropErr)
		}
	})
	cfg = cfg.Copy()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	cfg.MaxConns = 4
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	core, err := fs.ReadFile(migrations.Files(), "V1__initial_schema.sql")
	if err != nil {
		t.Fatal(err)
	}
	_, legacy, found := strings.Cut(string(core), "CREATE TABLE idempotency_keys (")
	if !found {
		t.Fatal("legacy schema missing")
	}
	legacy, _, found = strings.Cut(legacy, ");")
	if !found {
		t.Fatal("legacy schema is incomplete")
	}
	ddl, err := fs.ReadFile(migrations.Files(), "V15__durable_operation_receipts.sql")
	if err != nil {
		t.Fatal(err)
	}
	_, err = pool.Exec(
		t.Context(),
		"CREATE TABLE idempotency_keys ("+legacy+");"+string(
			ddl,
		)+"CREATE TABLE business_rows(id BIGSERIAL PRIMARY KEY, name TEXT NOT NULL);",
	)
	if err != nil {
		t.Fatal(err)
	}
	f := &operationFixture{t: t, pool: pool, repo: repository.NewIdempotencyRepository(pool)}
	f.router = f.routes(nil)
	return f
}

func (f *operationFixture) routes(handler gin.HandlerFunc) *gin.Engine {
	logger := slog.New(slog.DiscardHandler)
	middleware := idem.New(repository.NewIdempotencyRepository(f.pool), logger, nil)
	router := gin.New()
	router.Use(
		gin.CustomRecoveryWithWriter(
			io.Discard,
			func(c *gin.Context, _ any) { c.AbortWithStatus(http.StatusInternalServerError) },
		),
	)
	group := router.Group("/api/v1")
	group.Use(func(c *gin.Context) {
		id := int64(7)
		if raw := c.GetHeader("X-Test-User"); raw != "" {
			id, _ = strconv.ParseInt(raw, 10, 64)
		}
		if id <= 0 {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Set(userctx.KeyUser, userctx.UserContext{ID: id})
		c.Next()
	})
	group.Use(middleware.Handler())
	middleware.RegisterRoutes(group)
	if handler == nil {
		handler = f.writeBusiness
	}
	group.POST("/task", handler)
	group.PUT("/task/:id", handler)
	group.DELETE("/task/:id", handler)
	group.POST("/process", handler)
	group.POST("/user", handler)
	return router
}

func (f *operationFixture) writeBusiness(c *gin.Context) {
	var input struct {
		Name string `json:"name"`
	}
	if err := c.ShouldBindJSON(&input); err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	tx, ok := database.TxFrom(c.Request.Context())
	if !ok {
		f.t.Error("missing request transaction")
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	var id int64
	err := tx.QueryRow(c.Request.Context(), "INSERT INTO business_rows(name) VALUES($1) RETURNING id", input.Name).
		Scan(&id)
	if err != nil {
		f.t.Error(err)
		c.AbortWithStatus(http.StatusInternalServerError)
		return
	}
	c.JSON(http.StatusCreated, gin.H{"data": gin.H{"id": id}, "error": gin.H{}})
}

func operationRequest(method, target, id, body, user string) *http.Request {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if id != "" {
		req.Header.Set("Operation-Id", id)
	}
	if user != "" {
		req.Header.Set("X-Test-User", user)
	}
	return req
}

func operationCall(router http.Handler, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func (f *operationFixture) receipt(id, user string) *idem.OperationReceipt {
	f.t.Helper()
	reply := operationCall(f.router, operationRequest(http.MethodGet, "/api/v1/operations/"+id, "", "", user))
	if reply.Code != http.StatusOK {
		f.t.Fatalf("lookup: %d %s", reply.Code, reply.Body)
	}
	var result struct {
		Data idem.OperationReceipt `json:"data"`
	}
	if err := json.Unmarshal(reply.Body.Bytes(), &result); err != nil {
		f.t.Fatal(err)
	}
	return &result.Data
}

func (f *operationFixture) count(table string) int {
	f.t.Helper()
	var count int
	if err := f.pool.QueryRow(f.t.Context(), "SELECT count(*) FROM "+pgx.Identifier{table}.Sanitize()).
		Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}

func TestLegacyExpiryCanExecuteTheSameIntentAgain(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	post := func() *httptest.ResponseRecorder {
		req := operationRequest(http.MethodPost, "/api/v1/task", "", `{"name":"same intent"}`, "")
		req.Header.Set("Idempotency-Key", "legacy-expiry")
		return operationCall(f.router, req)
	}
	if got := post(); got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	if _, err := f.pool.Exec(
		t.Context(),
		"UPDATE idempotency_keys SET expires_at=now()-interval '2 days'",
	); err != nil {
		t.Fatal(err)
	}
	if err := f.repo.DeleteExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got := post(); got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	if f.count("business_rows") != 2 {
		t.Fatal("legacy expiry reproduction did not re-execute")
	}
}

type lostOperationResponse struct{ http.ResponseWriter }

func (w lostOperationResponse) WriteHeader(_ int) {}
func (w lostOperationResponse) Write(_ []byte) (int, error) {
	conn, _, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err == nil {
		_ = conn.Close()
	}
	return 0, io.ErrClosedPipe
}

func TestDurableLostResponseSurvivesExpiryCleanupAndServiceRestart(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	const body = `{"name":"saved before disconnect"}`
	server := httptest.NewServer(
		http.HandlerFunc(
			func(w http.ResponseWriter, r *http.Request) { f.router.ServeHTTP(lostOperationResponse{w}, r) },
		),
	)
	client := &http.Client{Timeout: operationTestTimeout}
	req, _ := http.NewRequestWithContext(
		t.Context(),
		http.MethodPost,
		server.URL+"/api/v1/task",
		strings.NewReader(body),
	)
	req.Header.Set("Operation-Id", "lost-response")
	req.Header.Set("Content-Type", "application/json")
	reply, err := client.Do(req)
	if reply != nil {
		reply.Body.Close()
	}
	server.Close()
	if err == nil {
		t.Fatal("the first response was supposed to be lost")
	}
	if _, err = f.pool.Exec(
		t.Context(),
		"UPDATE operation_receipts SET completed_at=now()-interval '10 years'",
	); err != nil {
		t.Fatal(err)
	}
	if err = f.repo.DeleteExpired(t.Context()); err != nil {
		t.Fatal(err)
	}
	f.repo = repository.NewIdempotencyRepository(f.pool)
	f.router = f.routes(nil)
	saved := f.receipt("lost-response", "")
	if saved.State != "confirmed" || saved.ResponseStatus != http.StatusCreated {
		t.Fatalf("saved receipt: %+v", saved)
	}
	again := operationCall(f.router, operationRequest(http.MethodPost, "/api/v1/task", "lost-response", body, ""))
	if again.Code != http.StatusCreated || again.Header().Get("Operation-Status") != "confirmed" ||
		again.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal(again.Code, again.Body)
	}
	if f.count("business_rows") != 1 || f.count("operation_receipts") != 1 {
		t.Fatal("lost acknowledgement duplicated or lost the operation")
	}
	var original, retry any
	if json.Unmarshal(saved.Response, &original) != nil || json.Unmarshal(again.Body.Bytes(), &retry) != nil {
		t.Fatal("invalid replay")
	}
	if !jsonEqual(original, retry) {
		t.Fatal("replay changed the saved object ID")
	}
}

func jsonEqual(first, second any) bool {
	a, _ := json.Marshal(first)
	b, _ := json.Marshal(second)
	return string(a) == string(b)
}

func TestDurableIdentityCannotChangeRequest(t *testing.T) {
	t.Parallel()
	cases := []struct{ name, method, path, body, contentType, key string }{
		{"body", http.MethodPost, "/api/v1/task", `{"name":"changed"}`, "application/json", ""},
		{"method", http.MethodDelete, "/api/v1/task/1", `{"name":"same"}`, "application/json", ""},
		{"path", http.MethodPost, "/api/v1/process", `{"name":"same"}`, "application/json", ""},
		{"query", http.MethodPost, "/api/v1/task?owner_id=8", `{"name":"same"}`, "application/json", ""},
		{"content-type", http.MethodPost, "/api/v1/task", `{"name":"same"}`, "application/json; charset=utf-8", ""},
	}
	for _, sample := range cases {
		t.Run(sample.name, func(t *testing.T) {
			t.Parallel()
			f := newOperationFixture(t)
			firstMethod, firstPath := http.MethodPost, "/api/v1/task"
			if sample.name == "method" {
				firstMethod, firstPath = http.MethodPut, "/api/v1/task/1"
			}
			if got := operationCall(
				f.router,
				operationRequest(firstMethod, firstPath, "bound-id", `{"name":"same"}`, ""),
			); got.Code != http.StatusCreated {
				t.Fatal(got.Code, got.Body)
			}
			req := operationRequest(sample.method, sample.path, "bound-id", sample.body, "")
			req.Header.Set("Content-Type", sample.contentType)
			req.Header.Set("Idempotency-Key", sample.key)
			got := operationCall(f.router, req)
			if got.Code != http.StatusConflict || got.Header().Get("Operation-Status") != "mismatch" ||
				f.count("business_rows") != 1 {
				t.Fatal(got.Code, got.Body)
			}
		})
	}
}

func TestDurableReceiptsAreIsolatedByAuthenticatedActor(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "private", `{"name":"actor seven"}`, "7"),
	); got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	if f.receipt("private", "8").State != "not_found" {
		t.Fatal("another actor discovered the receipt")
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "private", `{"name":"actor eight"}`, "8"),
	); got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	if f.count("business_rows") != 2 || f.receipt("private", "7").State != "confirmed" ||
		f.receipt("private", "8").State != "confirmed" {
		t.Fatal("actors shared operation state")
	}
	for _, target := range []string{"/api/v1/operations/private?user_id=7", "/api/v1/operations/private?owner_id=7"} {
		if got := operationCall(
			f.router,
			operationRequest(http.MethodGet, target, "", "", "8"),
		); got.Code != http.StatusBadRequest {
			t.Fatal("accepted a selectable receipt actor")
		}
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodGet, "/api/v1/operations/private", "", "", "0"),
	); got.Code != http.StatusUnauthorized {
		t.Fatal("unauthenticated receipt access")
	}
}

func TestDurableConcurrentServicesHaveOneWriter(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	entered, release, done := make(chan struct{}), make(chan struct{}), make(chan *httptest.ResponseRecorder, 1)
	first := f.routes(func(c *gin.Context) { f.writeBusiness(c); close(entered); <-release })
	go func() {
		done <- operationCall(first, operationRequest(http.MethodPost, "/api/v1/task", "concurrent", `{"name":"same"}`, ""))
	}()
	<-entered
	busy := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "concurrent", `{"name":"same"}`, ""),
	)
	state := f.receipt("concurrent", "").State
	before := f.count("business_rows")
	close(release)
	saved := <-done
	if busy.Code != http.StatusConflict || busy.Header().Get("Operation-Status") != "in_progress" ||
		state != "in_progress" ||
		before != 0 ||
		saved.Code != http.StatusCreated {
		t.Fatal("operation lock or pre-commit visibility failed", busy.Code, state, before, saved.Code)
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "concurrent", `{"name":"same"}`, ""),
	); got.Code != http.StatusCreated ||
		f.count("business_rows") != 1 {
		t.Fatal("concurrent retry duplicated work")
	}
}

func TestDurableNonSuccessRollsBackBusinessAndReceipt(t *testing.T) {
	t.Parallel()
	for _, status := range []int{400, 403, 409, 429, 500} {
		t.Run(strconv.Itoa(status), func(t *testing.T) {
			t.Parallel()
			f := newOperationFixture(t)
			denied := f.routes(func(c *gin.Context) { f.writeBusiness(c); c.Status(status) })
			got := operationCall(
				denied,
				operationRequest(http.MethodPost, "/api/v1/task", "retry-error", `{"name":"same"}`, ""),
			)
			if got.Code != status || got.Header().Get("Operation-Status") != "unrecorded" ||
				f.count("business_rows") != 0 ||
				f.receipt("retry-error", "").State != "not_found" {
				t.Fatal("non-success was persisted", got.Code, got.Body)
			}
			if retry := operationCall(
				f.router,
				operationRequest(http.MethodPost, "/api/v1/task", "retry-error", `{"name":"same"}`, ""),
			); retry.Code != http.StatusCreated ||
				f.count("business_rows") != 1 {
				t.Fatal("rolled-back operation could not retry")
			}
		})
	}
}

func TestDurableDatabaseCommitFailureIsAtomicAndRetryable(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	_, err := f.pool.Exec(
		t.Context(),
		"CREATE TABLE allowed_actors(id BIGINT PRIMARY KEY); ALTER TABLE operation_receipts ADD CONSTRAINT actor_commit FOREIGN KEY(user_id) REFERENCES allowed_actors(id) DEFERRABLE INITIALLY DEFERRED",
	)
	if err != nil {
		t.Fatal(err)
	}
	got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "failed-commit", `{"name":"same"}`, ""),
	)
	if got.Code != http.StatusInternalServerError || got.Header().Get("Operation-Status") != "unknown" ||
		f.count("business_rows") != 0 ||
		f.count("operation_receipts") != 0 {
		t.Fatal("commit failure leaked a business row or success", got.Code, got.Body)
	}
	if _, err = f.pool.Exec(t.Context(), "INSERT INTO allowed_actors VALUES(7)"); err != nil {
		t.Fatal(err)
	}
	if retry := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "failed-commit", `{"name":"same"}`, ""),
	); retry.Code != http.StatusCreated ||
		f.count("business_rows") != 1 {
		t.Fatal("retry after commit failure")
	}
}

func TestDurableReceiptInsertFailureRollsBackBusiness(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	if _, err := f.pool.Exec(
		t.Context(),
		"ALTER TABLE operation_receipts ADD CONSTRAINT deny_receipt CHECK(false)",
	); err != nil {
		t.Fatal(err)
	}
	got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "failed-receipt", `{"name":"same"}`, ""),
	)
	if got.Code != http.StatusInternalServerError || f.count("business_rows") != 0 ||
		f.receipt("failed-receipt", "").State != "not_found" {
		t.Fatal("receipt insertion failure left business data")
	}
}

func TestDurablePanicRollsBackAndReleasesLock(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	crash := f.routes(func(c *gin.Context) { f.writeBusiness(c); panic("simulated handler crash") })
	if got := operationCall(
		crash,
		operationRequest(http.MethodPost, "/api/v1/task", "panic", `{"name":"same"}`, ""),
	); got.Code != http.StatusInternalServerError ||
		f.count("business_rows") != 0 {
		t.Fatal("panic leaked transaction")
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "panic", `{"name":"same"}`, ""),
	); got.Code != http.StatusCreated ||
		f.count("business_rows") != 1 {
		t.Fatal("panic kept its lock")
	}
}

func TestDurableCompletionCannotRunOutsideBusinessTransaction(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	if err := f.repo.CompleteOperation(t.Context(), sqlc.CompleteOperationParams{}); err == nil {
		t.Fatal("detached receipt was accepted")
	}
}

func TestDurableLookupDatabaseFailureNeverMeansNotFound(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	if _, err := f.pool.Exec(t.Context(), "DROP TABLE operation_receipts"); err != nil {
		t.Fatal(err)
	}
	got := operationCall(f.router, operationRequest(http.MethodGet, "/api/v1/operations/unknown", "", "", ""))
	if got.Code != http.StatusInternalServerError || strings.Contains(got.Body.String(), "not_found") {
		t.Fatal("storage failure became safe absence", got.Code, got.Body)
	}
}

func TestDurableConnectionLossBeforeCommitRollsBack(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	crash := f.routes(func(c *gin.Context) {
		f.writeBusiness(c)
		tx, _ := database.TxFrom(c.Request.Context())
		var pid int32
		if err := tx.QueryRow(c.Request.Context(), "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			t.Error(err)
			return
		}
		if _, err := f.pool.Exec(c.Request.Context(), "SELECT pg_terminate_backend($1)", pid); err != nil {
			t.Error(err)
		}
	})
	if got := operationCall(
		crash,
		operationRequest(http.MethodPost, "/api/v1/task", "connection-loss", `{"name":"same"}`, ""),
	); got.Code != http.StatusInternalServerError {
		t.Fatal(got.Code, got.Body)
	}
	if f.count("business_rows") != 0 || f.receipt("connection-loss", "").State != "not_found" {
		t.Fatal("connection loss left unacknowledged business data")
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "connection-loss", `{"name":"same"}`, ""),
	); got.Code != http.StatusCreated ||
		f.count("business_rows") != 1 {
		t.Fatal("connection loss retry duplicated or failed")
	}
}

func TestDurableCancellationBeforeCommitDoesNotConfirm(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	canceled := f.routes(func(c *gin.Context) {
		f.writeBusiness(c)
		ctx, cancel := context.WithCancel(c.Request.Context())
		cancel()
		c.Request = c.Request.WithContext(ctx)
	})
	got := operationCall(canceled, operationRequest(http.MethodPost, "/api/v1/task", "canceled", `{"name":"same"}`, ""))
	if got.Code != http.StatusInternalServerError || f.count("business_rows") != 0 ||
		f.receipt("canceled", "").State != "not_found" {
		t.Fatal("canceled request was falsely confirmed")
	}
}

func TestDurableEmptyResponseReplaysWithoutAddingJSON(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	// Use a response-only mutation: a 204 must not acquire a JSON null payload on replay.
	router := f.routes(func(c *gin.Context) { c.Status(http.StatusNoContent) })
	for range 2 {
		got := operationCall(router, operationRequest(http.MethodDelete, "/api/v1/task/1", "empty", "", ""))
		if got.Code != http.StatusNoContent || got.Body.Len() != 0 {
			t.Fatal(got.Code, got.Body)
		}
	}
}

func TestDurableMissingReceiptHasNoForeignData(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	saved := f.receipt("missing", "")
	if saved.State != "not_found" || saved.Response != nil || saved.Method != "" || saved.RequestHash != "" {
		t.Fatalf("missing receipt %+v", saved)
	}
	capabilities := operationCall(f.router, operationRequest(http.MethodGet, "/api/v1/operations", "", "", ""))
	if capabilities.Code != http.StatusOK || !strings.Contains(capabilities.Body.String(), `"durable":true`) {
		t.Fatal(capabilities.Code, capabilities.Body)
	}
}

func TestDurableInvalidHeadersNeverFallBackToAnUnprotectedWrite(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"", ".", "..", "bad id", "bad/id", "кириллица", strings.Repeat("a", 129)} {
		t.Run(strconv.Itoa(len(id))+id[:min(len(id), 3)], func(t *testing.T) {
			t.Parallel()
			f := newOperationFixture(t)
			req := operationRequest(http.MethodPost, "/api/v1/task", "", `{"name":"same"}`, "")
			req.Header.Set("Operation-Id", id)
			got := operationCall(f.router, req)
			if got.Code != http.StatusBadRequest || f.count("business_rows") != 0 {
				t.Fatal("invalid header was ignored", got.Code)
			}
		})
	}
}

func TestDurableDuplicateHeadersAndReadMethodsAreRejected(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	req := operationRequest(http.MethodPost, "/api/v1/task", "a", `{"name":"same"}`, "")
	req.Header.Add("Operation-Id", "b")
	if got := operationCall(f.router, req); got.Code != http.StatusBadRequest {
		t.Fatal("duplicate operation identities accepted")
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodGet, "/api/v1/operations/a", "a", "", ""),
	); got.Code != http.StatusBadRequest {
		t.Fatal("GET stored as a mutation")
	}
	if f.count("business_rows") != 0 {
		t.Fatal("invalid requests executed")
	}
}

func TestDurableTransportKeyCanOnlyAliasTheOperationIdentity(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	req := operationRequest(http.MethodPost, "/api/v1/task", "alias", `{"name":"same"}`, "")
	req.Header.Set("Idempotency-Key", "different")
	if got := operationCall(f.router, req); got.Code != http.StatusBadRequest || f.count("business_rows") != 0 {
		t.Fatal("two independent identities were accepted")
	}
	req = operationRequest(http.MethodPost, "/api/v1/task", "alias", `{"name":"same"}`, "")
	req.Header.Set("Idempotency-Key", "alias")
	if got := operationCall(f.router, req); got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	if got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "alias", `{"name":"same"}`, ""),
	); got.Code != http.StatusCreated ||
		f.count("business_rows") != 1 {
		t.Fatal("the alias changed the durable identity")
	}
}

func TestDurableOversizedRequestDoesNotCreateAReceiptOrBusinessRow(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "large", strings.Repeat("x", 8<<20+1), ""),
	)
	if got.Code != http.StatusBadRequest || f.count("business_rows") != 0 || f.count("operation_receipts") != 0 {
		t.Fatal("oversized request was accepted", got.Code)
	}
}

func TestDurableInvalidJSONRollsBackWithoutAcknowledging(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	got := operationCall(f.router, operationRequest(http.MethodPost, "/api/v1/task", "bad-json", "{", ""))
	if got.Code != http.StatusBadRequest || f.count("operation_receipts") != 0 ||
		f.receipt("bad-json", "").State != "not_found" {
		t.Fatal("invalid JSON was acknowledged", got.Code)
	}
}

func TestDurableReceiptSurvivesOriginalEntityDeletion(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	first := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "history", `{"name":"same"}`, ""),
	)
	if first.Code != http.StatusCreated {
		t.Fatal(first.Code, first.Body)
	}
	if _, err := f.pool.Exec(t.Context(), "DELETE FROM business_rows"); err != nil {
		t.Fatal(err)
	}
	again := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "history", `{"name":"same"}`, ""),
	)
	if again.Code != http.StatusCreated || f.count("business_rows") != 0 ||
		f.receipt("history", "").State != "confirmed" {
		t.Fatal("recovery recreated a deleted entity", again.Code)
	}
}

func TestDurableRequestHashMatchesTheWireContract(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/task", "wire-hash", `{"name":"same"}`, ""),
	)
	if got.Code != http.StatusCreated {
		t.Fatal(got.Code, got.Body)
	}
	const expected = "5d220211854323ba0e8a89430062da590371afa8f877f20e96f46fb26f33077f"
	if saved := f.receipt("wire-hash", ""); saved.RequestHash != expected {
		t.Fatal("request hash protocol changed", saved.RequestHash)
	}
}

func TestDurableOnlineOnlyMutationsNeverPersistCredentialResponses(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	got := operationCall(
		f.router,
		operationRequest(http.MethodPost, "/api/v1/user", "credentials", `{"name":"not queued"}`, ""),
	)
	if got.Code != http.StatusBadRequest || f.count("business_rows") != 0 || f.count("operation_receipts") != 0 {
		t.Fatal("online-only handler entered durable execution", got.Code)
	}
}

func TestDurableReceiptFailureDoesNotExposeDatabaseDetails(t *testing.T) {
	t.Parallel()
	f := newOperationFixture(t)
	if _, err := f.pool.Exec(t.Context(), "DROP TABLE operation_receipts"); err != nil {
		t.Fatal(err)
	}
	got := operationCall(f.router, operationRequest(http.MethodPost, "/api/v1/task", "broken", `{"name":"same"}`, ""))
	if got.Code != http.StatusInternalServerError || strings.Contains(got.Body.String(), "operation_receipts") ||
		strings.Contains(got.Body.String(), "42P01") {
		t.Fatal("database details leaked", got.Code, got.Body)
	}
}
