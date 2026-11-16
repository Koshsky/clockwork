//nolint:testpackage // Exercises private Loki views alongside the public client.
package audit

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Koshsky/erp-backend/internal/config"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
)

func serveUserEvent(w http.ResponseWriter) {
	line := `{"actor_user_id":2,"actor_name":"Stored Name","actor_email":"stored-login","entity":"task","action":"update"}`
	json.NewEncoder(w).Encode(map[string]any{
		"status": "success",
		"data": map[string]any{"result": []any{map[string]any{
			"values": [][2]string{{"123", line}},
		}}},
	})
}

func TestAuditListUsesNeutralIdentities(t *testing.T) {
	t.Parallel()
	for _, filter := range []string{"IVANOV", "Иванов Иван", "ИВАНОВИЧ", "unknown"} {
		t.Run(filter, func(t *testing.T) {
			t.Parallel()
			queries := make(chan string, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				queries <- r.URL.Query().Get("query")
				serveUserEvent(w)
			}))
			defer server.Close()
			lookup := &stubLookup{users: []userdomain.Identity{{ID: 2, Username: "ivanov",
				Name: "Иванов Иван Иванович", LastName: "Иванов", FirstName: "Иван", MiddleName: new("Иванович")}}}
			client := NewClient(slog.New(slog.DiscardHandler), config.AuditConfig{URL: server.URL}, lookup)
			raw, total, _, _, err := client.List(t.Context(), url.Values{"user": {filter}})
			if err != nil {
				t.Fatal(err)
			}
			var views []lokiView
			if err = json.Unmarshal(raw, &views); err != nil {
				t.Fatal(err)
			}
			if filter == "unknown" {
				if len(queries) != 0 || len(views) != 0 || total != 0 {
					t.Fatal("unmatched user filter queried unfiltered audit events")
				}
				return
			}
			if total != 1 || len(views) != 1 || views[0].ActorName != "Иванов Иван Иванович" ||
				views[0].ActorEmail != "stored-login" || !strings.Contains(<-queries, `actor_user_id="2"`) {
				t.Fatalf("audit lost filtering or display enrichment: %s", raw)
			}
		})
	}
}

type failedIdentityLookup struct{ failure error }

func (l failedIdentityLookup) ListUserIdentities(context.Context) ([]userdomain.Identity, error) {
	return nil, l.failure
}

func TestAuditLookupFailurePreservesFilteringAndStoredNames(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		lookup UserLookup
	}{
		{"not configured", nil},
		{"database failure", failedIdentityLookup{errors.New("database unavailable")}},
		{"cancelled lookup", failedIdentityLookup{context.Canceled}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				requests.Add(1)
				serveUserEvent(w)
			}))
			defer server.Close()
			client := NewClient(slog.New(slog.DiscardHandler), config.AuditConfig{URL: server.URL}, tc.lookup)
			raw, total, _, _, err := client.List(t.Context(), url.Values{"user": {"worker"}})
			if err != nil || total != 0 || string(raw) != "[]" || requests.Load() != 0 {
				t.Fatalf("failed lookup broadened the audit filter: %s, %v", raw, err)
			}
			raw, total, _, _, err = client.List(t.Context(), url.Values{})
			var views []lokiView
			if err != nil || json.Unmarshal(raw, &views) != nil || total != 1 || len(views) != 1 ||
				views[0].ActorName != "Stored Name" || views[0].ActorEmail != "stored-login" {
				t.Fatalf("failed enrichment discarded stored audit data: %s, %v", raw, err)
			}
		})
	}
}
