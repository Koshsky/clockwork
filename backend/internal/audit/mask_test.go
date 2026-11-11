//nolint:testpackage // tests the unexported mask helpers directly
package audit

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestMaskJSONRedactsSensitiveKeys(t *testing.T) {
	t.Parallel()
	body := []byte(`{
		"username": "ivanov",
		"password": "secret123",
		"password_hash": "$2a$10$abc",
		"old_password": "old",
		"new_password": "new",
		"nested": {"access_token": "eyJ", "ok": true},
		"items": [{"token": "abc"}, {"name": "task"}]
	}`)
	masked := MaskJSON(body)
	var v map[string]any
	if err := json.Unmarshal(masked, &v); err != nil {
		t.Fatalf("result must be valid JSON: %v", err)
	}
	for _, key := range []string{"password", "password_hash", "old_password", "new_password"} {
		if v[key] != maskedValue {
			t.Fatalf("key %q must be masked, got %v", key, v[key])
		}
	}
	if v["username"] != "ivanov" {
		t.Fatalf("non-sensitive username must stay, got %v", v["username"])
	}
	if strings.Contains(string(masked), "secret123") || strings.Contains(string(masked), "eyJ") {
		t.Fatalf("sensitive value leaked into masked body: %s", masked)
	}
}

func TestMaskJSONNonJSONPassthrough(t *testing.T) {
	t.Parallel()
	raw := []byte("not json at all")
	if out := MaskJSON(raw); string(out) != string(raw) {
		t.Fatalf("non-JSON must pass through unchanged, got %s", out)
	}
}

func TestExtractEntityID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name string
		body string
		want *int64
	}{
		{"data.id", `{"data":{"id":12},"error":{}}`, new(int64(12))},
		{"data.user.id", `{"data":{"user":{"id":7}},"error":{}}`, new(int64(7))},
		{"no id", `{"data":{"code":"P-1"},"error":{}}`, nil},
		{"bad json", `nope`, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := extractEntityID([]byte(tc.body))
			if tc.want == nil {
				if got != nil {
					t.Fatalf("expected nil, got %d", *got)
				}
				return
			}
			if got == nil || *got != *tc.want {
				t.Fatalf("expected %d, got %v", *tc.want, got)
			}
		})
	}
}

func TestClassify(t *testing.T) {
	t.Parallel()
	cases := []struct {
		method, fullPath string
		wantEntity       string
		wantAction       string
		ok               bool
	}{
		{"POST", "/api/v1/project", "project", "create", true},
		{"DELETE", "/api/v1/task/:id/comments/:comment_id", "comment", "delete", true},
		{"PUT", "/api/v1/user/:id/days", "user", "set_days", true},
		{"POST", "/api/v1/auth/login", "auth", "login", true},
		{"PUT", "/api/v1/rbac/policies", "rbac", "upsert_policy", true},
		{"GET", "/api/v1/project", "", "", false},
		{"POST", "/api/v1/unknown", "", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.fullPath, func(t *testing.T) {
			t.Parallel()
			rc, ok := classify(tc.method, tc.fullPath)
			if ok != tc.ok {
				t.Fatalf("expected ok=%v, got %v", tc.ok, ok)
			}
			if ok {
				if rc.entity != tc.wantEntity || rc.action != tc.wantAction {
					t.Fatalf("expected %s/%s, got %s/%s", tc.wantEntity, tc.wantAction, rc.entity, rc.action)
				}
			}
		})
	}
}
