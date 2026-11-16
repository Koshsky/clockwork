package service_test

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/authz/service"
	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

type policyLoad struct {
	rules       []sqlc.ListActivePresetRulesRow
	routes      []domain.RoutePolicy
	users       []sqlc.ListUserPrincipalsRow
	permissions []sqlc.ListAllUserPermissionsRow
	failCall    int
	failure     error
}

type snapshotRepository struct {
	service.PolicyRepository

	mu    sync.Mutex
	load  policyLoad
	calls int
}

func (r *snapshotRepository) replace(load policyLoad) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.load, r.calls = load, 0
}

func (r *snapshotRepository) next() (policyLoad, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls++
	if r.calls == r.load.failCall {
		return r.load, r.load.failure
	}
	return r.load, nil
}

func (r *snapshotRepository) ListActiveRules(context.Context) ([]sqlc.ListActivePresetRulesRow, error) {
	load, err := r.next()
	return load.rules, err
}

func (r *snapshotRepository) ListActiveRoutePolicies(context.Context) ([]domain.RoutePolicy, error) {
	load, err := r.next()
	return load.routes, err
}

func (r *snapshotRepository) ListUserPrincipals(context.Context) ([]sqlc.ListUserPrincipalsRow, error) {
	load, err := r.next()
	return load.users, err
}

func (r *snapshotRepository) ListAllUserPermissions(context.Context) ([]sqlc.ListAllUserPermissionsRow, error) {
	load, err := r.next()
	return load.permissions, err
}

func policyFixture(name, resource, preset string) policyLoad {
	return policyLoad{
		rules: []sqlc.ListActivePresetRulesRow{{
			Preset: "worker", Resource: resource, Action: "update", Scope: "all",
		}},
		routes: []domain.RoutePolicy{{Name: name, Kind: "entity", Params: map[string]any{
			"resource": resource, "action": "update", "owner": "none",
		}}},
		users: []sqlc.ListUserPrincipalsRow{{UserID: 7, Preset: sql.NullString{String: preset, Valid: true}}},
	}
}

func preserveDefaultPolicies(t *testing.T) {
	t.Helper()
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
}

func newSnapshotStore(repo *snapshotRepository, interval time.Duration) (*service.PolicyStore, *rbac.Middleware) {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{}, nil)
	store := service.NewPolicyStore(slog.New(slog.DiscardHandler), repo, mw, config.Duration(interval))
	return store, mw
}

func routeStatus(mw *rbac.Middleware, name string) int {
	response := httptest.NewRecorder()
	c, router := gin.CreateTestContext(response)
	c.Request = httptest.NewRequest(http.MethodGet, "/probe", nil)
	router.Use(func(ctx *gin.Context) { ctx.Set(userctx.KeyUser, domain.UserContext{ID: 1, Admin: true}) })
	router.GET("/probe", mw.Check(name), func(ctx *gin.Context) { ctx.Status(http.StatusNoContent) })
	router.ServeHTTP(response, c.Request)
	return response.Code
}

func assertSnapshot(t *testing.T, store *service.PolicyStore, mw *rbac.Middleware, name string,
	want domain.UserContext, oldScope, newScope string,
) {
	t.Helper()
	got, err := store.EffectiveUser(t.Context(), 7)
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("principal changed: got=%+v want=%+v error=%v", got, want, err)
	}
	actor := domain.UserContext{ID: 42, Preset: "worker"}
	if scope := engine.ScopeForUser(actor, domain.ResourceProject, engine.ActionUpdate); scope != oldScope {
		t.Fatalf("project scope=%q want=%q", scope, oldScope)
	}
	if scope := engine.ScopeForUser(actor, domain.ResourceTask, engine.ActionUpdate); scope != newScope {
		t.Fatalf("task scope=%q want=%q", scope, newScope)
	}
	if status := routeStatus(mw, name); status != http.StatusNoContent {
		t.Fatalf("active route %s returned %d", name, status)
	}
}

//nolint:paralleltest // Mutates the global policy snapshot.
func TestPolicyStoreRejectsPartialReloads(t *testing.T) {
	preserveDefaultPolicies(t)
	failure := errors.New("database unavailable")
	for _, tc := range []struct {
		name   string
		mutate func(*policyLoad)
	}{
		{"matrix read", func(l *policyLoad) { l.failCall = 1 }},
		{"route read", func(l *policyLoad) { l.failCall = 2 }},
		{"principal read", func(l *policyLoad) { l.failCall = 3 }},
		{"override read", func(l *policyLoad) { l.failCall = 4 }},
		{"assignment read", func(l *policyLoad) { l.failCall = 5 }},
		{"ACL read", func(l *policyLoad) { l.failCall = 6 }},
		{"empty routes", func(l *policyLoad) { l.routes = nil }},
		{"invalid kind", func(l *policyLoad) { l.routes[0].Kind = "unknown" }},
		{"invalid parameters", func(l *policyLoad) { l.routes[0].Params["resource"] = true }},
		{"invalid matrix", func(l *policyLoad) { l.rules[0].Scope = "unknown" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &snapshotRepository{load: policyFixture("old", "project", "worker")}
			store, mw := newSnapshotStore(repo, time.Hour)
			if err := store.Reload(t.Context()); err != nil {
				t.Fatal(err)
			}
			candidate := policyFixture("new", "task", "admin")
			candidate.failure = failure
			tc.mutate(&candidate)
			repo.replace(candidate)
			err := store.Reload(t.Context())
			if err == nil || (candidate.failCall != 0 && !errors.Is(err, failure)) {
				t.Fatalf("reload did not preserve failure: %v", err)
			}
			assertSnapshot(t, store, mw, "old", domain.UserContext{ID: 7, Preset: "worker"},
				engine.ScopeAll, engine.ScopeNone)
			if status := routeStatus(mw, "new"); status != http.StatusForbidden {
				t.Fatalf("rejected route became active: %d", status)
			}
		})
	}
}

//nolint:paralleltest // Mutates the global policy snapshot.
func TestPolicyStoreReloadReplacesRulesAndPrincipals(t *testing.T) {
	preserveDefaultPolicies(t)
	for _, tc := range []struct {
		name       string
		preset     string
		permission *sqlc.ListAllUserPermissionsRow
		removed    bool
		want       domain.UserContext
		wantScope  string
	}{
		{name: "preset", preset: "vp", want: domain.UserContext{ID: 7, Preset: "vp"}, wantScope: engine.ScopeNone},
		{name: "admin", preset: "admin", want: domain.UserContext{ID: 7, Preset: "admin", Admin: true}, wantScope: engine.ScopeAll},
		{name: "removed", removed: true, want: domain.UserContext{ID: 7}, wantScope: engine.ScopeNone},
		{name: "grant", preset: "vp", permission: &sqlc.ListAllUserPermissionsRow{
			UserID: 7, Resource: "task", Action: "update", Scope: "all", Granted: true,
		}, want: domain.UserContext{ID: 7, Preset: "vp", Rules: []domain.PermissionRule{{
			Resource: "task", Action: "update", Scope: "all", Granted: true,
		}}}, wantScope: engine.ScopeAll},
		{name: "revoke", preset: "worker", permission: &sqlc.ListAllUserPermissionsRow{
			UserID: 7, Resource: "task", Action: "update", Granted: false,
		}, want: domain.UserContext{ID: 7, Preset: "worker", Rules: []domain.PermissionRule{{
			Resource: "task", Action: "update", Granted: false,
		}}}, wantScope: engine.ScopeNone},
	} {
		t.Run(tc.name, func(t *testing.T) {
			repo := &snapshotRepository{load: policyFixture("old", "project", "worker")}
			store, mw := newSnapshotStore(repo, time.Hour)
			if err := store.Reload(t.Context()); err != nil {
				t.Fatal(err)
			}
			candidate := policyFixture("new", "task", tc.preset)
			if tc.removed {
				candidate.users = nil
			}
			if tc.permission != nil {
				candidate.permissions = []sqlc.ListAllUserPermissionsRow{*tc.permission}
			}
			repo.replace(candidate)
			if err := store.Reload(t.Context()); err != nil {
				t.Fatal(err)
			}
			assertSnapshot(t, store, mw, "new", tc.want, engine.ScopeNone, engine.ScopeAll)
			if scope := engine.ScopeForUser(tc.want, domain.ResourceTask, engine.ActionUpdate); scope != tc.wantScope {
				t.Fatalf("effective user scope=%q want=%q", scope, tc.wantScope)
			}
			if status := routeStatus(mw, "old"); status != http.StatusForbidden {
				t.Fatalf("obsolete route remained active: %d", status)
			}
		})
	}
}

type routePublisherFunc func([]engine.RouteSpec) (func(), error)

func (f routePublisherFunc) PrepareRoutes(specs []engine.RouteSpec) (func(), error) {
	return f(specs)
}

//nolint:paralleltest // Mutates the global policy snapshot.
func TestPolicyStorePublicationOrder(t *testing.T) {
	preserveDefaultPolicies(t)
	repo := &snapshotRepository{load: policyFixture("old", "project", "worker")}
	var store *service.PolicyStore
	prepared, applied := false, false
	armed := false
	before := domain.UserContext{ID: 7, Preset: "worker"}
	publisher := routePublisherFunc(func(specs []engine.RouteSpec) (func(), error) {
		if !armed {
			return func() {}, nil
		}
		prepared = len(specs) == 1 && specs[0].Name == "new"
		return func() {
			applied = true
			actor := domain.UserContext{ID: 42, Preset: "worker"}
			if engine.ScopeForUser(actor, domain.ResourceTask, engine.ActionUpdate) != engine.ScopeAll {
				t.Error("routes published before matrix")
			}
			principal, _ := store.EffectiveUser(t.Context(), 7)
			if !reflect.DeepEqual(principal, before) {
				t.Error("principals published before routes")
			}
		}, nil
	})
	store = service.NewPolicyStore(slog.New(slog.DiscardHandler), repo, publisher, config.Duration(time.Hour))
	if err := store.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	armed = true
	repo.replace(policyFixture("new", "task", "admin"))
	if err := store.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	principal, _ := store.EffectiveUser(t.Context(), 7)
	if !prepared || !applied || !principal.Admin {
		t.Fatalf("incomplete publication: prepare=%v apply=%v principal=%+v", prepared, applied, principal)
	}
}

//nolint:paralleltest // Mutates the global policy snapshot.
func TestPolicyStoreTTLRecoversAfterStartupFailure(t *testing.T) {
	preserveDefaultPolicies(t)
	repo := &snapshotRepository{load: policyLoad{failCall: 1, failure: errors.New("database unavailable")}}
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{}, []rbac.Policy{
		{Name: "fallback", Check: func(*rbac.CheckCtx) error { return nil }},
	})
	applied := make(chan struct{}, 1)
	var attempts sync.Mutex
	accepted := false
	publisher := routePublisherFunc(func(specs []engine.RouteSpec) (func(), error) {
		attempts.Lock()
		defer attempts.Unlock()
		// Later ticks must not overwrite another test's process-wide snapshot.
		if accepted {
			return nil, errors.New("test snapshot already published")
		}
		apply, err := mw.PrepareRoutes(specs)
		if err != nil {
			return nil, err
		}
		accepted = true
		return func() {
			apply()
			select {
			case applied <- struct{}{}:
			default:
			}
		}, nil
	})
	store := service.NewPolicyStore(slog.New(slog.DiscardHandler), repo, publisher, config.Duration(time.Millisecond))
	fallbackScope := engine.ViewScopeCode("rp", domain.ResourceProject)
	store.Start()
	defer store.Stop()
	if !store.IsReady() || routeStatus(mw, "fallback") != http.StatusNoContent {
		t.Fatal("startup failure discarded fallback")
	}
	if fallbackScope == engine.ScopeNone || engine.ViewScopeCode("rp", domain.ResourceProject) != fallbackScope {
		t.Fatal("startup failure discarded the built-in matrix")
	}
	principal, _ := store.EffectiveUser(t.Context(), 7)
	if principal.Preset != "" || principal.Admin {
		t.Fatal("failed startup granted a principal")
	}
	repo.replace(policyFixture("recovered", "project", "worker"))
	select {
	case <-applied:
	case <-time.After(5 * time.Second):
		t.Fatal("TTL did not recover")
	}
	if routeStatus(mw, "recovered") != http.StatusNoContent || routeStatus(mw, "fallback") != http.StatusForbidden {
		t.Fatal("TTL did not replace fallback routes")
	}
}

//nolint:paralleltest // Mutates the global policy snapshot.
func TestPolicyStoreConcurrentReadersDuringReload(t *testing.T) {
	preserveDefaultPolicies(t)
	repo := &snapshotRepository{load: policyFixture("probe", "project", "worker")}
	store, mw := newSnapshotStore(repo, time.Hour)
	if err := store.Reload(t.Context()); err != nil {
		t.Fatal(err)
	}
	var readers sync.WaitGroup
	stop := make(chan struct{})
	for range 4 {
		readers.Go(func() { readPolicySnapshots(t, store, mw, stop) })
	}
	defer func() { close(stop); readers.Wait() }()
	for i := range 30 {
		preset := "worker"
		if i%2 != 0 {
			preset = "admin"
		}
		repo.replace(policyFixture("probe", "project", preset))
		if err := store.Reload(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
}

func readPolicySnapshots(t *testing.T, store *service.PolicyStore, mw *rbac.Middleware, stop <-chan struct{}) {
	t.Helper()
	for {
		select {
		case <-stop:
			return
		default:
		}
		principal, err := store.EffectiveUser(t.Context(), 7)
		if err != nil || principal.ID != 7 || principal.Admin != (principal.Preset == "admin") {
			t.Error("torn principal snapshot")
			return
		}
		if routeStatus(mw, "probe") != http.StatusNoContent {
			t.Error("route unavailable during replacement")
			return
		}
		if engine.ScopeForUser(principal, domain.ResourceProject, engine.ActionUpdate) != engine.ScopeAll {
			t.Error("matrix unavailable during replacement")
			return
		}
	}
}
