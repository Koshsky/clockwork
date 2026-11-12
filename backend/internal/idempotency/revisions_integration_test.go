//go:build integration

package idempotency_test

import (
	"context"
	"encoding/json"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/database"
	idem "github.com/Koshsky/erp-backend/internal/idempotency"
	"github.com/Koshsky/erp-backend/internal/response"
	"github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/migrations"
)

func newRevisionFixture(t *testing.T) *operationFixture {
	t.Helper()
	f := newOperationFixture(t)
	_, err := f.pool.Exec(t.Context(), `
 CREATE TABLE projects(id bigint PRIMARY KEY, code text);
 CREATE TABLE processes(id bigint PRIMARY KEY, project_id bigint, title text);
 CREATE TABLE tasks(id bigint PRIMARY KEY, process_id bigint, title text);
 CREATE TABLE milestones(id bigint PRIMARY KEY, process_id bigint, title text);
 CREATE TABLE assignments(id bigint PRIMARY KEY, task_id bigint, resource_id bigint, quantity int);
 CREATE TABLE task_dependencies(id bigint PRIMARY KEY, task_id bigint, depends_on_task_id bigint, type text);
 CREATE TABLE resources(id bigint PRIMARY KEY, title text);
 CREATE TABLE resource_members(resource_id bigint, user_id bigint);
 CREATE TABLE user_states(id bigint PRIMARY KEY, user_id bigint, state_id bigint);
 CREATE TABLE states(id bigint PRIMARY KEY, name text);
 CREATE TABLE users(id bigint PRIMARY KEY);
 INSERT INTO projects VALUES(1,'initial');
 INSERT INTO processes VALUES(1,1,'initial');
 INSERT INTO tasks VALUES(1,1,'initial');
 INSERT INTO resources VALUES(1,'initial');
 INSERT INTO users VALUES(1);
 INSERT INTO states VALUES(1,'initial');`)
	if err != nil {
		t.Fatal(err)
	}
	ddl, err := fs.ReadFile(migrations.Files(), "V16__operation_revision_guards.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.pool.Exec(t.Context(), string(ddl)); err != nil {
		t.Fatal(err)
	}
	return f
}

func revisionFixtureTokens(t *testing.T, f *operationFixture, key string) string {
	t.Helper()
	tokens, err := f.repo.RevisionTokens(t.Context(), []string{key})
	if err != nil || tokens[key] == "" {
		t.Fatal("missing token", key, err)
	}
	return tokens[key]
}

func TestRevisionSnapshotAndTokensShareOneMVCCSnapshot(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	before := revisionFixtureTokens(t, f, "process:1")
	entered, release := make(chan struct{}), make(chan struct{})
	middleware := idem.New(f.repo, slog.New(slog.DiscardHandler), nil)
	router := gin.New()
	group := router.Group("/api/v1")
	group.Use(middleware.RevisionHandler())
	group.GET("/planning/tasks", func(c *gin.Context) {
		tx, ok := database.TxFrom(c.Request.Context())
		if !ok {
			t.Error("snapshot has no transaction")
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		var title string
		if err := tx.QueryRow(c.Request.Context(), "SELECT title FROM tasks WHERE id=1").Scan(&title); err != nil {
			t.Error(err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		close(entered)
		<-release
		response.OK(
			c,
			map[string]any{
				"processes": []any{
					map[string]any{"id": 1, "tasks": []any{map[string]any{"id": 1, "process_id": 1, "title": title}}},
				},
			},
		)
	})
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/planning/tasks", nil)
		req.Header.Set("Revision-Protocol", "1")
		result <- operationCall(router, req)
	}()
	<-entered
	if _, err := f.pool.Exec(t.Context(), "UPDATE tasks SET title='newer' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	close(release)
	reply := <-result
	if reply.Code != http.StatusOK {
		t.Fatal("snapshot request failed", reply.Code)
	}
	var body struct {
		Data idem.RevisionSnapshot `json:"data"`
	}
	if err := json.Unmarshal(reply.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Data.Revisions["process:1"] != before ||
		!strings.Contains(string(body.Data.Snapshot), `"title":"initial"`) {
		t.Fatal("new token was paired with old business data")
	}
	if revisionFixtureTokens(t, f, "process:1") == before {
		t.Fatal("external writer did not advance revision")
	}
}

//nolint:paralleltest,tparallel // The ordered mutations exercise one aggregate history, including its final deletion.
func TestRevisionTriggersCoverLegacyWritesAndTombstones(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	for _, test := range []struct{ name, key, sql string }{
		{"project invalidates process", "process:1", "UPDATE projects SET code='changed' WHERE id=1"},
		{"process invalidates project", "project:1", "UPDATE processes SET title='changed' WHERE id=1"},
		{"task invalidates process", "process:1", "UPDATE tasks SET title='changed' WHERE id=1"},
		{"milestone", "process:1", "INSERT INTO milestones VALUES(1,1,'milestone')"},
		{"assignment", "process:1", "INSERT INTO assignments VALUES(1,1,1,1)"},
		{"dependency", "process:1", "INSERT INTO task_dependencies VALUES(1,1,1,'fs')"},
		{"membership", "resource:1", "INSERT INTO resource_members VALUES(1,1)"},
		{"employee profile", "resource:1", "UPDATE users SET id=id WHERE id=1"},
		{"absence", "user_days:1", "INSERT INTO user_states VALUES(1,1,1)"},
		{"day kind", "states", "UPDATE states SET name='changed' WHERE id=1"},
		{"delete preserves process tombstone", "process:1", "DELETE FROM processes WHERE id=1"},
		{"delete preserves resource tombstone", "resource:1", "DELETE FROM resources WHERE id=1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			before := revisionFixtureTokens(t, f, test.key)
			if _, err := f.pool.Exec(t.Context(), test.sql); err != nil {
				t.Fatal(err)
			}
			if revisionFixtureTokens(t, f, test.key) == before {
				t.Fatal("legacy SQL left a stale revision")
			}
		})
	}
}

func TestRevisionRollbackPreservesBusinessAndBaselineTogether(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	before := revisionFixtureTokens(t, f, "process:1")
	tx, err := f.pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(t.Context(), "UPDATE tasks SET title='rolled back' WHERE id=1"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	if revisionFixtureTokens(t, f, "process:1") != before {
		t.Fatal("rolled-back data advanced revision")
	}
	var title string
	if err = f.pool.QueryRow(t.Context(), "SELECT title FROM tasks WHERE id=1").
		Scan(&title); err != nil ||
		title != "initial" {
		t.Fatal("business rollback failed", title, err)
	}
}

func TestRevisionReadStorageFailureNeverReturnsAnUnguardedSnapshot(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	if _, err := f.pool.Exec(t.Context(), "DROP TABLE operation_revisions"); err != nil {
		t.Fatal(err)
	}
	middleware := idem.New(f.repo, slog.New(slog.DiscardHandler), nil)
	router := gin.New()
	router.Use(middleware.RevisionHandler())
	router.GET(
		"/api/v1/planning/tasks",
		func(c *gin.Context) { response.OK(c, map[string]any{"processes": []any{map[string]any{"id": 1}}}) },
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/planning/tasks", nil)
	req.Header.Set("Revision-Protocol", "1")
	reply := operationCall(router, req)
	if reply.Code != http.StatusInternalServerError {
		t.Fatal("storage failure downgraded to unguarded data", reply.Code)
	}
	if strings.Contains(reply.Body.String(), "operation_revisions") {
		t.Fatal("storage details leaked")
	}
}

func TestRevisionGuardDoesNotPublishAnUncommittedWrite(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	middleware := idem.New(f.repo, slog.New(slog.DiscardHandler), nil)
	router := gin.New()
	group := router.Group("/api/v1")
	group.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, userctx.UserContext{ID: 7}) })
	group.Use(middleware.Handler(), middleware.RevisionHandler())
	group.PUT("/task/:id", func(c *gin.Context) {
		tx, ok := database.TxFrom(c.Request.Context())
		if !ok {
			t.Error("missing transaction")
			return
		}
		if _, err := tx.Exec(c.Request.Context(), "UPDATE tasks SET title='attempted' WHERE id=1"); err != nil {
			t.Error(err)
			c.AbortWithStatus(http.StatusInternalServerError)
			return
		}
		response.OK(c, map[string]any{"id": 1, "process_id": 1, "title": "attempted"})
	})
	req := operationRequest(http.MethodPut, "/api/v1/task/1", "stale", `{"_preconditions":{"process:1":"old"}}`, "")
	req.Header.Set("Revision-Protocol", "1")
	reply := operationCall(router, req)
	if reply.Code != http.StatusConflict {
		t.Fatal("stale write was not blocked", reply.Code)
	}
	var title string
	if err := f.pool.QueryRow(context.Background(), "SELECT title FROM tasks WHERE id=1").
		Scan(&title); err != nil ||
		title != "initial" {
		t.Fatal("stale write committed", err)
	}
}

func TestRevisionReadIncompleteMetadataFailsClosed(t *testing.T) {
	t.Parallel()
	f := newRevisionFixture(t)
	if _, err := f.pool.Exec(t.Context(), "DELETE FROM operation_revisions WHERE key='process:1'"); err != nil {
		t.Fatal(err)
	}
	middleware := idem.New(f.repo, slog.New(slog.DiscardHandler), nil)
	router := gin.New()
	router.Use(middleware.RevisionHandler())
	router.GET(
		"/api/v1/planning/tasks",
		func(c *gin.Context) { response.OK(c, map[string]any{"processes": []any{map[string]any{"id": 1}}}) },
	)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/planning/tasks", nil)
	req.Header.Set("Revision-Protocol", "1")
	reply := operationCall(router, req)
	if reply.Code != http.StatusInternalServerError {
		t.Fatal("missing token produced unsafe baseline", reply.Code)
	}
}
