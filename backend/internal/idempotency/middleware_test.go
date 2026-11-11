package idempotency_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	idem "github.com/Koshsky/erp-backend/internal/idempotency"
	"github.com/Koshsky/erp-backend/internal/idempotency/repository"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// headerKey is the wire name of the Idempotency-Key header.
const headerKey = "Idempotency-Key"

// keyScope is the composite identifier of an idempotency claim.
type keyScope struct {
	key    string
	userID int64
	method string
	path   string
}

// fakeRepo is an in-memory Repo used to exercise the middleware without a DB.
type fakeRepo struct {
	mu          sync.Mutex
	complete    map[keyScope]repository.StoredResult
	inflight    map[keyScope]bool
	claims      int
	completes   int
	releases    int
	completeErr bool
	commitErr   bool
	lastTx      *fakeTx
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		complete: map[keyScope]repository.StoredResult{},
		inflight: map[keyScope]bool{},
	}
}

func scope(key string, userID int64, method, path string) keyScope {
	return keyScope{key: key, userID: userID, method: method, path: path}
}

func (f *fakeRepo) Claim(
	_ context.Context,
	key string,
	userID int64,
	method, path string,
	_ time.Time,
) (*repository.StoredResult, bool, pgx.Tx, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := scope(key, userID, method, path)
	if res, ok := f.complete[s]; ok {
		r := res
		return &r, false, nil, nil
	}
	if f.inflight[s] {
		return nil, false, nil, nil
	}
	f.inflight[s] = true
	f.claims++
	tx := &fakeTx{commitErr: f.commitErr}
	f.lastTx = tx
	return nil, true, tx, nil
}

func (f *fakeRepo) Complete(
	_ context.Context,
	key string,
	userID int64,
	method, path string,
	status int,
	body json.RawMessage,
) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.completeErr {
		return errors.New("complete failed")
	}
	s := scope(key, userID, method, path)
	f.complete[s] = repository.StoredResult{Status: status, Body: body}
	delete(f.inflight, s)
	f.completes++
	return nil
}

func (f *fakeRepo) Release(_ context.Context, key string, userID int64, method, path string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	s := scope(key, userID, method, path)
	delete(f.complete, s)
	delete(f.inflight, s)
	f.releases++
	return nil
}

func (f *fakeRepo) DeleteExpired(context.Context) error { return nil }

func (f *fakeRepo) completesCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.completes
}

// setUser installs the fixed test user (id 7) into the gin context.
func setUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Set(userctx.KeyUser, userctx.UserContext{ID: 7})
		c.Next()
	}
}

// buildRouter wires an idempotency handler around a POST endpoint that counts
// executions and responds with a JSON body, returning the built router.
func buildRouter(mw *idem.Middleware, counter *int) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(setUser())
	router.Use(mw.Handler())
	router.POST("/tasks", func(c *gin.Context) {
		*counter++
		c.JSON(http.StatusCreated, gin.H{"id": *counter})
	})
	return router
}

// doPost issues a request through the router with an optional Idempotency-Key.
func doPost(router http.Handler, key string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/tasks", nil)
	if key != "" {
		req.Header.Set(headerKey, key)
	}
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)
	return rec
}

func TestIdempotencyNoKeyPassesThrough(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	rec := doPost(router, "")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusCreated)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.claims != 0 {
		t.Fatalf("claims = %d, want 0 (no key => no claim)", repo.claims)
	}
}

func TestIdempotencyReplaysSameKey(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	first := doPost(router, "k-1")
	if first.Code != http.StatusCreated {
		t.Fatalf("first status = %d, want %d", first.Code, http.StatusCreated)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times after first, want 1", counter)
	}
	if repo.completesCount() != 1 {
		t.Fatalf("completes after first = %d, want 1", repo.completesCount())
	}

	second := doPost(router, "k-1")
	if second.Code != http.StatusCreated {
		t.Fatalf("replay status = %d, want %d", second.Code, http.StatusCreated)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times after replay, want still 1 (no duplicate)", counter)
	}
	if second.Body.String() != first.Body.String() {
		t.Fatalf(
			"replay body = %q, want first body %q (same saved response)",
			second.Body.String(), first.Body.String(),
		)
	}
}

func TestIdempotencyInFlightReturnsConflict(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	// Emulate "in flight": the first request with the key has not finished yet.
	repo.mu.Lock()
	repo.inflight[scope("k-x", 7, http.MethodPost, "/tasks")] = true
	repo.mu.Unlock()

	rec := doPost(router, "k-x")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (409 in-flight)", rec.Code, http.StatusConflict)
	}
	if counter != 0 {
		t.Fatalf("handler executed %d times, want 0 (must not re-execute)", counter)
	}
}

func TestIdempotencyFiveHundredReleasesKey(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(setUser())
	router.Use(mw.Handler())
	router.POST("/boom", func(c *gin.Context) {
		c.String(http.StatusInternalServerError, "boom")
	})

	req := httptest.NewRequest(http.MethodPost, "/boom", nil)
	req.Header.Set(headerKey, "k-5")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.releases != 1 {
		t.Fatalf("releases = %d, want 1 (5xx must release the key)", repo.releases)
	}
	if _, ok := repo.complete[scope("k-5", 7, http.MethodPost, "/boom")]; ok {
		t.Fatalf("5xx response must NOT be cached for replay")
	}
}

func TestIdempotencyFourXxReleasesKey(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(setUser())
	router.Use(mw.Handler())
	router.POST("/invalid", func(c *gin.Context) {
		c.JSON(http.StatusUnprocessableEntity, gin.H{"error": "bad"})
	})

	req := httptest.NewRequest(http.MethodPost, "/invalid", nil)
	req.Header.Set(headerKey, "k-4")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnprocessableEntity {
		t.Fatalf("status = %d, want 422", rec.Code)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.completes != 0 {
		t.Fatalf("completes = %d, want 0 (4xx must not be cached)", repo.completes)
	}
	if repo.releases != 1 {
		t.Fatalf("releases = %d, want 1 (4xx must release the key for retry)", repo.releases)
	}
}

func TestIdempotencyReplayHeaders(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	doPost(router, "k-h")
	second := doPost(router, "k-h")

	if second.Code != http.StatusCreated {
		t.Fatalf("replay status = %d, want 201", second.Code)
	}
	if ct := second.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("replay Content-Type = %q, want application/json", ct)
	}
	if re := second.Header().Get("Idempotency-Replayed"); re != "true" {
		t.Fatalf("replay Idempotency-Replayed = %q, want true", re)
	}
}

func TestIdempotencyOverlongKeyPassesThrough(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	req := httptest.NewRequest(http.MethodPost, "/tasks", nil)
	req.Header.Set(headerKey, "k-"+string(make([]byte, 300)))
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (pass-through)", rec.Code)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.claims != 0 {
		t.Fatalf("claims = %d, want 0 (overlong key must not be claimed)", repo.claims)
	}
}

func TestIdempotencyWithoutAuthPassesThrough(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	// Without setUser — userctx.GetUserID returns an error, the middleware passes through.
	router.Use(mw.Handler())
	counter := 0
	router.POST("/tasks", func(c *gin.Context) {
		counter++
		c.Status(http.StatusCreated)
	})

	req := httptest.NewRequest(http.MethodPost, "/tasks", nil)
	req.Header.Set(headerKey, "k")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", rec.Code)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1 (no auth => pass through)", counter)
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.claims != 0 {
		t.Fatalf("claims = %d, want 0", repo.claims)
	}
}

// fakeTx is a pgx.Tx stub recording commit/rollback; every other operation is
// never reached by the middleware.
type fakeTx struct {
	mu         sync.Mutex
	committed  bool
	rolledBack bool
	commitErr  bool
}

func (f *fakeTx) Commit(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.commitErr {
		return errors.New("commit failed")
	}
	f.committed = true
	return nil
}

func (f *fakeTx) Rollback(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.rolledBack = true
	return nil
}

func (f *fakeTx) Begin(context.Context) (pgx.Tx, error) { return nil, errors.New("unused") }
func (f *fakeTx) CopyFrom(context.Context, pgx.Identifier, []string, pgx.CopyFromSource) (int64, error) {
	return 0, errors.New("unused")
}
func (f *fakeTx) SendBatch(context.Context, *pgx.Batch) pgx.BatchResults { return nil }
func (f *fakeTx) LargeObjects() pgx.LargeObjects                         { return pgx.LargeObjects{} }
func (f *fakeTx) Prepare(context.Context, string, string) (*pgconn.StatementDescription, error) {
	return nil, errors.New("unused")
}
func (f *fakeTx) Exec(context.Context, string, ...any) (pgconn.CommandTag, error) {
	return pgconn.CommandTag{}, errors.New("unused")
}
func (f *fakeTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, errors.New("unused")
}
func (f *fakeTx) QueryRow(context.Context, string, ...any) pgx.Row { return nil }
func (f *fakeTx) Conn() *pgx.Conn                                  { return nil }
func (f *fakeTx) isCommitted() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.committed
}
func (f *fakeTx) isRolledBack() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.rolledBack
}

// tx returns the transaction of the most recent claim (under the repo mutex).
func (f *fakeRepo) tx() *fakeTx {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.lastTx
}

// TestIdempotencyCommitFlushDeliversAfterCommit verifies the response reaches
// the client only after the request transaction committed (2xx path).
func TestIdempotencyCommitFlushDeliversAfterCommit(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	rec := doPost(router, "k-c")
	if rec.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusCreated)
	}
	if rec.Body.Len() == 0 {
		t.Fatal("response body must be delivered after commit")
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	tx := repo.tx()
	if tx == nil {
		t.Fatal("claim must open a request transaction")
	}
	if !tx.isCommitted() {
		t.Fatal("transaction must be committed on a 2xx response")
	}
	if tx.isRolledBack() {
		t.Fatal("transaction must not be rolled back after commit")
	}
}

// TestIdempotencyFiveHundredRollsBackAndReleases covers the 5xx path: the
// transaction is rolled back, the key released and the error response still
// delivered to the client.
func TestIdempotencyFiveHundredRollsBackAndReleases(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(setUser())
	router.Use(mw.Handler())
	router.POST("/boom", func(c *gin.Context) {
		c.String(http.StatusInternalServerError, "boom")
	})

	req := httptest.NewRequest(http.MethodPost, "/boom", nil)
	req.Header.Set(headerKey, "k-5")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", rec.Code)
	}
	if rec.Body.String() != "boom" {
		t.Fatalf("body = %q, want %q", rec.Body.String(), "boom")
	}
	tx := repo.tx()
	if tx == nil {
		t.Fatal("claim must open a request transaction")
	}
	if !tx.isRolledBack() {
		t.Fatal("transaction must be rolled back on a non-2xx response")
	}
	if tx.isCommitted() {
		t.Fatal("transaction must not be committed on a non-2xx response")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.releases != 1 {
		t.Fatalf("releases = %d, want 1 (5xx must release the key)", repo.releases)
	}
}

// TestIdempotencyPanicRollsBackAndRestoresWriter verifies a panicking handler
// rolls back the transaction and gin.Recovery() still reaches the client (the
// buffered writer must not swallow the 500).
func TestIdempotencyPanicRollsBackAndRestoresWriter(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	mw := idem.New(repo, nil, nil)

	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(gin.RecoveryWithWriter(io.Discard))
	router.Use(setUser())
	router.Use(mw.Handler())
	counter := 0
	router.POST("/panic", func(_ *gin.Context) {
		counter++
		panic("boom")
	})

	req := httptest.NewRequest(http.MethodPost, "/panic", nil)
	req.Header.Set(headerKey, "k-p")
	rec := httptest.NewRecorder()
	router.ServeHTTP(rec, req)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 from gin.Recovery", rec.Code)
	}
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	tx := repo.tx()
	if tx == nil {
		t.Fatal("claim must open a request transaction")
	}
	if !tx.isRolledBack() {
		t.Fatal("transaction must be rolled back after a panic")
	}
	if tx.isCommitted() {
		t.Fatal("transaction must not be committed after a panic")
	}
}

// TestIdempotencyCompleteFailureRollsBack verifies a storage failure while
// completing the key rolls back the transaction and answers a single JSON 500
// instead of delivering the handler's 2xx.
func TestIdempotencyCompleteFailureRollsBack(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	repo.mu.Lock()
	repo.completeErr = true
	repo.mu.Unlock()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	rec := doPost(router, "k-e")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (complete failure must not deliver the 2xx)", rec.Code)
	}
	// The body must be a single well-formed {data,error} document, not the 2xx
	// body concatenated with the error envelope (invalid double JSON).
	assertSingleJSONError(t, rec.Body.Bytes())
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	tx := repo.tx()
	if tx == nil {
		t.Fatal("claim must open a request transaction")
	}
	if !tx.isRolledBack() {
		t.Fatal("transaction must be rolled back when completion fails")
	}
	if tx.isCommitted() {
		t.Fatal("transaction must not be committed when completion fails")
	}
}

// TestIdempotencyCommitFailureDeliversSingleJSONError covers the commit-ambiguity
// path: the transaction commit fails after the key was completed; the client
// must get a single well-formed 500 {data,error} document and the key must stay
// in-flight (deliberately not released).
func TestIdempotencyCommitFailureDeliversSingleJSONError(t *testing.T) {
	t.Parallel()
	repo := newFakeRepo()
	repo.mu.Lock()
	repo.commitErr = true
	repo.mu.Unlock()
	mw := idem.New(repo, nil, nil)
	counter := 0
	router := buildRouter(mw, &counter)

	rec := doPost(router, "k-cf")
	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (commit failure must not deliver the 2xx)", rec.Code)
	}
	assertSingleJSONError(t, rec.Body.Bytes())
	if counter != 1 {
		t.Fatalf("handler executed %d times, want 1", counter)
	}
	tx := repo.tx()
	if tx == nil {
		t.Fatal("claim must open a request transaction")
	}
	if tx.isCommitted() {
		t.Fatal("transaction must not be committed when commit fails")
	}
	repo.mu.Lock()
	defer repo.mu.Unlock()
	if repo.releases != 0 {
		t.Fatalf("releases = %d, want 0 (commit ambiguity must leave the key in-flight)", repo.releases)
	}
}

// assertSingleJSONError asserts the body parses as exactly one JSON document
// carrying the {data,error} envelope with a non-nil error. A concatenation of
// two JSON documents (the buffered 2xx body + the error envelope) fails the
// unmarshal, catching the double-JSON defect.
func assertSingleJSONError(t *testing.T, body []byte) {
	t.Helper()
	var envelope struct {
		Data  json.RawMessage `json:"data"`
		Error *struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		t.Fatalf("body is not a single JSON document: %v\nbody: %s", err, body)
	}
	if envelope.Error == nil {
		t.Fatalf("error envelope missing in body: %s", body)
	}
}
