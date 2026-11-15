package delivery_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	state "github.com/Koshsky/erp-backend/internal/timesheet/state"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/delivery"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/dto"
	"github.com/Koshsky/erp-backend/internal/timesheet/state/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

type catalogRepository struct {
	reads, writes int
}

func (*catalogRepository) initial() sqlc.State {
	return sqlc.State{ID: 3, Code: "WORK", Name: "Work day", IsAvailable: true,
		Color: sql.NullString{String: "#abcdef", Valid: true}}
}

func (r *catalogRepository) FindState(context.Context, int64) (*sqlc.State, error) {
	r.reads++
	return new(r.initial()), nil
}

func (r *catalogRepository) ListStates(context.Context) ([]sqlc.State, error) {
	r.reads++
	return []sqlc.State{r.initial()}, nil
}

func (r *catalogRepository) CreateState(
	_ context.Context,
	code, name string,
	available bool,
	color *string,
) (*sqlc.State, error) {
	r.writes++
	row := sqlc.State{ID: 3, Code: code, Name: name, IsAvailable: available}
	if color != nil {
		row.Color = sql.NullString{String: *color, Valid: true}
	}
	return &row, nil
}

func (r *catalogRepository) UpdateState(_ context.Context, row sqlc.State) (*sqlc.State, error) {
	r.writes++
	return &row, nil
}

func (r *catalogRepository) DeleteState(context.Context, int64) error { r.writes++; return nil }

func stateRouter(user access.UserContext, repo *catalogRepository) *gin.Engine {
	mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{}, rbac.ProvideAll())
	svc := state.NewService(slog.New(slog.DiscardHandler), tracing.New(nil), repo)
	handler := delivery.NewStateHandler(slog.New(slog.DiscardHandler), svc, mw)
	_, router := gin.CreateTestContext(httptest.NewRecorder())
	router.Use(func(c *gin.Context) { c.Set(userctx.KeyUser, user) })
	handler.RegisterRoutes(router.Group("/api/v1"))
	return router
}

func stateRequest(router *gin.Engine, method, suffix, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/api/v1/timesheet/states"+suffix, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

//nolint:paralleltest // Publishes the process-wide authorization snapshot.
func TestStateHTTPAdministrationIsolation(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	input := engine.PublishInput{Grants: []engine.RuleGrant{
		{Sub: "catalog", Key: "state/view", Scope: "all"},
		{Sub: "other-admin", Key: "state/view", Scope: "all"},
		{Sub: "other-admin", Key: "user_admin/update", Scope: "all"},
	}}
	for _, action := range []string{"view", "create", "update", "delete"} {
		input.Grants = append(input.Grants, engine.RuleGrant{Sub: "manager", Key: "state/" + action, Scope: "all"})
	}
	if err := engine.Publish(input); err != nil {
		t.Fatal(err)
	}
	for _, role := range []struct {
		name         string
		view, manage bool
		admin        bool
	}{
		{"none", false, false, false}, {"catalog", true, false, false},
		{"other-admin", true, false, false}, {"manager", true, true, false}, {"admin", true, true, true},
	} {
		for _, operation := range []struct {
			method, path, body string
			status             int
		}{
			{"GET", "", "", 200}, {"GET", "/3", "", 200},
			{"POST", "", `{"code":"OFF","name":"Leave"}`, 201},
			{"PUT", "/3", `{"is_available":false}`, 200}, {"DELETE", "/3", "", 204},
		} {
			t.Run(role.name+"/"+operation.method+operation.path, func(t *testing.T) {
				repo := &catalogRepository{}
				response := stateRequest(
					stateRouter(access.UserContext{ID: 7, Preset: role.name, Admin: role.admin}, repo),
					operation.method,
					operation.path,
					operation.body,
				)
				read := operation.method == http.MethodGet
				allowed := (read && role.view) || (!read && role.manage)
				assertCatalogAccess(t, response, repo, read, allowed, operation.status)
			})
		}
	}
}

func assertCatalogAccess(t *testing.T, response *httptest.ResponseRecorder, repo *catalogRepository,
	read, allowed bool, successStatus int,
) {
	t.Helper()
	want, writes := successStatus, 0
	if !allowed {
		want = http.StatusForbidden
		if read {
			want = http.StatusNotFound
		}
	} else if !read {
		writes = 1
	}
	if response.Code != want || repo.writes != writes || (!allowed && repo.reads != 0) {
		t.Fatalf("administration scope leaked: status=%d writes=%d reads=%d body=%s",
			response.Code, repo.writes, repo.reads, response.Body.String())
	}
}

func TestStateHTTPPayloadSemantics(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name, method, path, body string
		status                   int
		available                bool
		color                    *string
	}{
		{"default", "POST", "", `{"code":"OFF","name":"Leave"}`, 201, false, nil},
		{"available", "POST", "", `{"code":"ON","name":"Work","is_available":true}`, 201, true, nil},
		{"disable", "PUT", "/3", `{"is_available":false}`, 200, false, new("#abcdef")},
		{"null", "PUT", "/3", `{"is_available":null,"color":null}`, 200, true, new("#abcdef")},
		{"clear color", "PUT", "/3", `{"color":""}`, 200, true, nil},
		{"bad bool", "PUT", "/3", `{"is_available":"false"}`, 400, false, nil},
		{"invalid color", "PUT", "/3", `{"color":"red"}`, 400, false, nil},
		{"missing code", "POST", "", `{"name":"Leave"}`, 400, false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			repo := &catalogRepository{}
			response := stateRequest(
				stateRouter(access.UserContext{ID: 7, Admin: true}, repo),
				tc.method,
				tc.path,
				tc.body,
			)
			if response.Code != tc.status || (tc.status == 400 && repo.writes != 0) {
				t.Fatalf(
					"payload contract changed: status=%d writes=%d body=%s",
					response.Code,
					repo.writes,
					response.Body.String(),
				)
			}
			if tc.status == 400 {
				return
			}
			var result struct {
				Data dto.StateResponse `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil ||
				result.Data.IsAvailable != tc.available || !reflect.DeepEqual(result.Data.Color, tc.color) {
				t.Fatalf("payload fields changed: %s, %v", response.Body.String(), err)
			}
		})
	}
}
