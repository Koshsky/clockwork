//go:build integration

package idempotency_test

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	idem "github.com/Koshsky/erp-backend/internal/idempotency"
	idemrepo "github.com/Koshsky/erp-backend/internal/idempotency/repository"
	processdelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/process/delivery"
	processrepo "github.com/Koshsky/erp-backend/internal/project_mgmt/process/repository"
	processservice "github.com/Koshsky/erp-backend/internal/project_mgmt/process/service"
	taskdelivery "github.com/Koshsky/erp-backend/internal/project_mgmt/task/delivery"
	taskrepo "github.com/Koshsky/erp-backend/internal/project_mgmt/task/repository"
	taskservice "github.com/Koshsky/erp-backend/internal/project_mgmt/task/service"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/migrations"
)

const (
	appendConcurrency = 12
	appendWriterLock  = 718226341
	appendLockTimeout = 5 * time.Second
	appendPollDelay   = 10 * time.Millisecond
)

type appendOrderFixture struct {
	pool    *pgxpool.Pool
	router  *gin.Engine
	appName string
}

func newAppendOrderFixture(t *testing.T) *appendOrderFixture {
	t.Helper()
	address := os.Getenv("OPERATION_TEST_DATABASE_URL")
	if address == "" {
		t.Skip("set OPERATION_TEST_DATABASE_URL to an isolated erp_operations_ database")
	}
	cfg, err := pgxpool.ParseConfig(address)
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
	name := "append_" + strings.ToLower(rand.Text())
	schema := pgx.Identifier{name}.Sanitize()
	if _, err = base.Exec(t.Context(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), operationTestTimeout)
		defer cancel()
		if _, dropErr := base.Exec(ctx, "DROP SCHEMA "+schema+" CASCADE"); dropErr != nil {
			t.Error(dropErr)
		}
	})
	cfg = cfg.Copy()
	cfg.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	cfg.ConnConfig.RuntimeParams["application_name"] = name
	cfg.MaxConns = appendConcurrency + 4
	pool, err := pgxpool.NewWithConfig(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	applyAppendMigrations(t, pool)
	_, err = pool.Exec(t.Context(), `
INSERT INTO users(id,username,password_hash,first_name,last_name,preset)
VALUES(1,'append-user','test-only','Append','Fixture','admin');
INSERT INTO projects(id,owner_id,code,start_date,end_date,priority)
VALUES(1,1,'append-project','2026-11-01','2026-12-31',100);
INSERT INTO processes(id,project_id,owner_id,title,start_date,end_date,sort_order)
VALUES(1,1,1,'seed-process','2026-11-01','2026-12-31',1);
SELECT setval(pg_get_serial_sequence('processes','id'),1);`)
	if err != nil {
		t.Fatal(err)
	}
	f := &appendOrderFixture{pool: pool, appName: name}
	f.router = appendOrderRouter(pool)
	return f
}

func applyAppendMigrations(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err = tx.Exec(t.Context(), "SELECT pg_advisory_xact_lock($1)", appendWriterLock); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), "CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public"); err != nil {
		t.Fatal(err)
	}
	files := migrations.Files()
	entries, err := fs.ReadDir(files, ".")
	if err != nil {
		t.Fatal(err)
	}
	type versioned struct {
		name    string
		version int
	}
	var ordered []versioned
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		raw, _, _ := strings.Cut(strings.TrimPrefix(entry.Name(), "V"), "__")
		version, parseErr := strconv.Atoi(raw)
		if parseErr != nil {
			t.Fatal(parseErr)
		}
		ordered = append(ordered, versioned{entry.Name(), version})
	}
	slices.SortFunc(ordered, func(a, b versioned) int { return a.version - b.version })
	for _, migration := range ordered {
		body, readErr := fs.ReadFile(files, migration.name)
		if readErr != nil {
			t.Fatal(readErr)
		}
		if _, err = tx.Exec(t.Context(), string(body)); err != nil {
			t.Fatalf("apply %s: %v", migration.name, err)
		}
	}
	if err = tx.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func appendOrderRouter(pool *pgxpool.Pool) *gin.Engine {
	logger := slog.New(slog.DiscardHandler)
	tracer := tracing.New(nil)
	tasks := taskdelivery.NewTaskHandler(
		logger,
		taskservice.NewTaskService(logger, tracer, taskrepo.NewTaskRepository(logger, pool), nil),
		nil,
	)
	processes := processdelivery.NewProcessHandler(
		logger,
		processservice.NewProcessService(logger, tracer, processrepo.NewProcessRepository(logger, pool)),
		nil,
	)
	middleware := idem.New(idemrepo.NewIdempotencyRepository(pool), logger, tracer)
	router := gin.New()
	group := router.Group("/api/v1")
	group.Use(func(c *gin.Context) {
		c.Set(userctx.KeyUser, userctx.UserContext{ID: 1, Admin: true, Preset: "admin"})
		c.Next()
	})
	group.Use(middleware.Handler(), middleware.RevisionHandler())
	middleware.RegisterRoutes(group)
	group.POST("/task", tasks.CreateTask)
	group.POST("/process", processes.CreateProcess)
	group.GET("/process/:id", processes.FindProcess)
	return router
}

func (f *appendOrderFixture) call(
	t *testing.T,
	route string,
	body []byte,
	headers http.Header,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1"+route, bytes.NewReader(body)).WithContext(t.Context())
	req.Header = headers.Clone()
	req.Header.Set("Content-Type", "application/json")
	return operationCall(f.router, req)
}

func appendOrderBody(t *testing.T, process bool, parent int64, index int) []byte {
	t.Helper()
	value := map[string]any{
		"title": "append-intent-" + strconv.Itoa(index), "owner_id": 1,
		"start_date": "2026-11-01", "end_date": "2026-12-31",
	}
	if process {
		value["project_id"] = 1
	} else {
		value["process_id"] = 1
	}
	if parent > 0 {
		value["parent_id"] = parent
	}
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func (f *appendOrderFixture) concurrent(
	t *testing.T,
	route string,
	bodies [][]byte,
	headers []http.Header,
) []*httptest.ResponseRecorder {
	t.Helper()
	blocker, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(context.Background()) }()
	if _, err = blocker.Exec(t.Context(), "SELECT pg_advisory_xact_lock($1)", appendWriterLock); err != nil {
		t.Fatal(err)
	}
	replies := make([]*httptest.ResponseRecorder, len(bodies))
	var group sync.WaitGroup
	for index := range bodies {
		group.Go(func() { replies[index] = f.call(t, route, bodies[index], headers[index]) })
	}
	f.waitBlocked(t, len(bodies))
	if err = blocker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	group.Wait()
	return replies
}

func (f *appendOrderFixture) waitBlocked(t *testing.T, count int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), appendLockTimeout)
	defer cancel()
	ticker := time.NewTicker(appendPollDelay)
	defer ticker.Stop()
	for {
		var blocked int
		err := f.pool.QueryRow(ctx, `
SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
WHERE l.locktype='advisory' AND NOT l.granted AND a.application_name=$1`, f.appName).Scan(&blocked)
		if err != nil {
			t.Fatal("append contenders did not reach writer lock", err)
		}
		if blocked == count {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("only %d of %d append requests reached writer lock", blocked, count)
		case <-ticker.C:
		}
	}
}

func TestAppendHTTPConcurrentCreates(t *testing.T) {
	t.Parallel()
	for _, scenario := range []struct {
		name    string
		process bool
		keyed   bool
		subtask bool
	}{
		{name: "plain root tasks"},
		{name: "distinct legacy keyed root tasks", keyed: true},
		{name: "same parent subtasks", subtask: true},
		{name: "same project processes", process: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			t.Parallel()
			f := newAppendOrderFixture(t)
			parent := int64(0)
			if scenario.subtask {
				reply := f.call(t, "/task", appendOrderBody(t, false, 0, -1), http.Header{})
				parent = appendCreatedID(t, reply)
			}
			bodies, headers := make([][]byte, appendConcurrency), make([]http.Header, appendConcurrency)
			for index := range bodies {
				bodies[index], headers[index] = appendOrderBody(t, scenario.process, parent, index), http.Header{}
				if scenario.keyed {
					headers[index].Set("Idempotency-Key", f.appName+strconv.Itoa(index))
				}
			}
			route, table, first := "/task", "tasks", 1
			if scenario.process {
				route, table, first = "/process", "processes", 2
			}
			assertAppendCreated(t, f.concurrent(t, route, bodies, headers))
			assertAppendOrders(t, f.pool, table, first)
		})
	}
}

func assertAppendCreated(t *testing.T, replies []*httptest.ResponseRecorder) {
	t.Helper()
	ids := make(map[int64]bool)
	for _, reply := range replies {
		id := appendCreatedID(t, reply)
		if ids[id] {
			t.Fatal("distinct intents returned the same entity")
		}
		ids[id] = true
	}
}

func appendCreatedID(t *testing.T, reply *httptest.ResponseRecorder) int64 {
	t.Helper()
	if reply.Code != http.StatusCreated {
		t.Fatalf("create HTTP %d: %s", reply.Code, reply.Body.String())
	}
	var envelope struct {
		Data struct {
			ID int64 `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(reply.Body.Bytes(), &envelope); err != nil || envelope.Data.ID <= 0 {
		t.Fatal("missing created entity", err)
	}
	return envelope.Data.ID
}

func assertAppendOrders(t *testing.T, pool *pgxpool.Pool, table string, first int) {
	t.Helper()
	rows, err := pool.Query(t.Context(), "SELECT sort_order FROM "+pgx.Identifier{table}.Sanitize()+
		" WHERE title LIKE 'append-intent-%' AND title <> 'append-intent--1' ORDER BY sort_order")
	if err != nil {
		t.Fatal(err)
	}
	orders, err := pgx.CollectRows(rows, pgx.RowTo[int])
	if err != nil || len(orders) != appendConcurrency {
		t.Fatal("missing concurrent append", orders, err)
	}
	for index, order := range orders {
		if order != first+index {
			t.Fatal("append order is not unique and contiguous", orders)
		}
	}
}

func TestAppendHTTPLegacyReplayCreatesOneEntity(t *testing.T) {
	t.Parallel()
	f := newAppendOrderFixture(t)
	body, headers := appendOrderBody(t, false, 0, 0), http.Header{"Idempotency-Key": {"same-append"}}
	first, again := f.call(t, "/task", body, headers), f.call(t, "/task", body, headers)
	if appendCreatedID(t, first) != appendCreatedID(t, again) || again.Header().Get("Idempotency-Replayed") != "true" {
		t.Fatal("legacy replay created a different task")
	}
	var count int
	if err := f.pool.QueryRow(t.Context(), "SELECT count(*) FROM tasks").Scan(&count); err != nil || count != 1 {
		t.Fatal("replay appended an extra entity", count, err)
	}
}

func TestAppendHTTPDurableCreatesKeepTheOriginalRevision(t *testing.T) {
	t.Parallel()
	f := newAppendOrderFixture(t)
	read := httptest.NewRequest(http.MethodGet, "/api/v1/process/1", nil)
	read.Header.Set("Revision-Protocol", "1")
	baseline := operationCall(f.router, read)
	var envelope struct {
		Data idem.RevisionSnapshot `json:"data"`
	}
	if err := json.Unmarshal(baseline.Body.Bytes(), &envelope); err != nil || baseline.Code != http.StatusOK {
		t.Fatal("missing original process snapshot", err)
	}
	bodies, headers := make([][]byte, 2), make([]http.Header, 2)
	for index := range bodies {
		var body map[string]any
		if err := json.Unmarshal(appendOrderBody(t, false, 0, index), &body); err != nil {
			t.Fatal(err)
		}
		body["_preconditions"] = envelope.Data.Revisions
		bodies[index], _ = json.Marshal(body)
		headers[index] = http.Header{
			"Operation-Id":      {"guarded-append-" + strconv.Itoa(index)},
			"Revision-Protocol": {"1"},
		}
	}
	counts := map[int]int{}
	for _, reply := range f.concurrent(t, "/task", bodies, headers) {
		counts[reply.Code]++
		if reply.Code == http.StatusConflict && reply.Header().Get("Revision-Status") != "conflict" {
			t.Fatal("stale baseline was confused with a sort-order collision")
		}
	}
	if counts[http.StatusCreated] != 1 || counts[http.StatusConflict] != 1 {
		t.Fatal("append silently rebased an old durable intent", counts)
	}
	var count int
	if err := f.pool.QueryRow(t.Context(), "SELECT count(*) FROM tasks").Scan(&count); err != nil || count != 1 {
		t.Fatal("stale durable creation escaped rollback", count, err)
	}
}
