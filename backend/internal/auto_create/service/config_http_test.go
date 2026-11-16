package service_test

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/jackc/pgx/v5"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/auto_create/delivery"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/userctx"
)

//nolint:paralleltest // Publishes and restores the shared authorization snapshot.
func TestConfigHTTPContractAndAdministrationScopes(t *testing.T) {
	t.Cleanup(func() {
		if err := engine.Publish(engine.DefaultPublishInput()); err != nil {
			t.Fatal(err)
		}
	})
	if err := engine.Publish(engine.PublishInput{Grants: []engine.RuleGrant{
		{Sub: "template-view", Key: "auto_create/view", Scope: "all"},
		{Sub: "template-update", Key: "auto_create/update", Scope: "all"},
	}}); err != nil {
		t.Fatal(err)
	}
	admin := &access.UserContext{ID: 7, Admin: true}
	viewer := &access.UserContext{ID: 7, Preset: "template-view"}
	updater := &access.UserContext{ID: 7, Preset: "template-update"}
	for _, tc := range []struct {
		name, method, body, want string
		user                     *access.UserContext
		readErr                  error
		status, calls            int
	}{
		{"default config", http.MethodGet, "", `{"enabled":false,"processes":[]}`, admin, pgx.ErrNoRows, 200, 1},
		{"viewer reads", http.MethodGet, "", `{"enabled":true,"processes":[]}`, viewer, nil, 200, 1},
		{"updater reads", http.MethodGet, "", `{"enabled":true,"processes":[]}`, updater, nil, 200, 1},
		{"null write response", http.MethodPut, `{"enabled":false}`, `{"enabled":false,"processes":null}`, updater, nil, 200, 1},
		{"empty write response", http.MethodPut, `{"enabled":true,"processes":[]}`, `{"enabled":true,"processes":[]}`, admin, nil, 200, 1},
		{"viewer cannot save", http.MethodPut, `{"enabled":false}`, "", viewer, nil, 403, 0},
		{"no capability", http.MethodGet, "", "", &access.UserContext{ID: 7}, nil, 403, 0},
		{"anonymous", http.MethodGet, "", "", nil, nil, 401, 0},
		{"malformed body", http.MethodPut, "{", "", admin, nil, 400, 0},
		{"invalid template", http.MethodPut, `{"enabled":false,"processes":[{"title":" "}]}`, "", admin, nil, 400, 0},
		{"read failure", http.MethodGet, "", "", admin, errors.New("private database detail"), 500, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tx := &templateTransaction{raw: json.RawMessage("[]"), enabled: true, readErr: tc.readErr}
			svc := templateService(t, tx)
			mw := rbac.ProvideMiddleware(nil, tracing.New(nil), rbac.Data{}, rbac.ProvideAll())
			handler := delivery.NewAutoCreateHandler(slog.New(slog.DiscardHandler), svc, mw)
			_, router := gin.CreateTestContext(httptest.NewRecorder())
			router.Use(func(c *gin.Context) {
				if tc.user != nil {
					c.Set(userctx.KeyUser, *tc.user)
				}
			})
			handler.RegisterRoutes(router.Group("/api/v1"))
			request := httptest.NewRequest(tc.method, "/api/v1/auto-create/config", strings.NewReader(tc.body)).
				WithContext(tx.ctx)
			request.Header.Set("Content-Type", "application/json")
			reply := httptest.NewRecorder()
			router.ServeHTTP(reply, request)
			if reply.Code != tc.status || len(tx.calls) != tc.calls || tx.finalized {
				t.Fatalf(
					"HTTP/transaction contract changed: status=%d calls=%+v body=%s",
					reply.Code,
					tx.calls,
					reply.Body,
				)
			}
			checkTemplateHTTPReply(t, reply, tc.want)
		})
	}
}

func checkTemplateHTTPReply(t *testing.T, reply *httptest.ResponseRecorder, want string) {
	t.Helper()
	if want != "" {
		var envelope struct {
			Data json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(reply.Body.Bytes(), &envelope); err != nil {
			t.Fatal(err)
		}
		assertTemplateJSON(t, envelope.Data, want)
	}
	if reply.Code == http.StatusInternalServerError &&
		strings.Contains(reply.Body.String(), "private database detail") {
		t.Fatal("private repository error leaked into HTTP response")
	}
}
