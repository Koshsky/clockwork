//nolint:testpackage // tests the unexported LogQL builder and page helpers
package audit

import (
	"net/url"
	"strings"
	"testing"
)

func TestBuildLogQLBasics(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{}, nil)
	if !strings.HasPrefix(q, `{service="erp",kind="audit"}`) {
		t.Fatalf("selector prefix missing: %s", q)
	}
	if !strings.Contains(q, "| json | __error__=\"\"") {
		t.Fatalf("json parser missing: %s", q)
	}
}

func TestBuildLogQLFilters(t *testing.T) {
	t.Parallel()
	params := url.Values{
		"entity":  {"project"},
		"action":  {"create"},
		"user_id": {"3"},
		"status":  {"201"},
		"search":  {"ivan"},
	}
	q := buildLogQL(params, nil)
	for _, want := range []string{
		`entity="project"`,
		`action="create"`,
		`|~ "(?i)ivan"`,
		`actor_user_id="3"`,
		`status="201"`,
	} {
		if !strings.Contains(q, want) {
			t.Fatalf("query missing %q: %s", want, q)
		}
	}
}

func TestBuildLogQLUserIDsORGroup(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{}, []int64{3, 7, 12})
	want := `(actor_user_id="3" or actor_user_id="7" or actor_user_id="12")`
	if !strings.Contains(q, want) {
		t.Fatalf("user ids must form an OR group, got: %s", q)
	}
}

func TestBuildLogQLStatusGroup(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{"status": {"4xx"}}, nil)
	want := `(status="400" or status="401" or status="403" or status="404" or status="405"`
	if !strings.Contains(q, want) {
		t.Fatalf("4xx must expand to an OR group, got: %s", q)
	}
	if !strings.Contains(q, `or status="422"`) || !strings.Contains(q, `status="429"`) {
		t.Fatalf("4xx group must include common codes, got: %s", q)
	}
}

func TestBuildLogQLStatusExactBackCompat(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{"status": {"201"}}, nil)
	if !strings.Contains(q, `status="201"`) {
		t.Fatalf("exact status code must stay a plain equality, got: %s", q)
	}
	// Unknown group/code is skipped.
	if q2 := buildLogQL(url.Values{"status": {"1xx"}}, nil); strings.Contains(q2, "status=") {
		t.Fatalf("unknown status must be skipped, got: %s", q2)
	}
}

func TestBuildLogQLIPAndIDFilters(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{"id": {"23"}, "ip": {"172.18.0.1"}}, nil)
	if !strings.Contains(q, `(entity_id="23" or actor_user_id="23")`) {
		t.Fatalf("id must match the ID-column display, got: %s", q)
	}
	// IP is an exact equality on the actor_ip field — not a whole-line
	// substring (which would match unrelated fields).
	if !strings.Contains(q, `actor_ip="172.18.0.1"`) {
		t.Fatalf("ip must be an exact field equality, got: %s", q)
	}
	if strings.Contains(q, `|~`) && strings.Contains(q, `172`) {
		t.Fatalf("ip must not be a line filter, got: %s", q)
	}
	if q2 := buildLogQL(url.Values{"id": {"abc"}}, nil); strings.Contains(q2, "entity_id=") {
		t.Fatalf("non-numeric id must be skipped, got: %s", q2)
	}
}

func TestBuildLogQLIgnoresBadNumericFilters(t *testing.T) {
	t.Parallel()
	q := buildLogQL(url.Values{"user_id": {"abc"}, "status": {"xyz"}}, nil)
	if strings.Contains(q, "actor_user_id=") || strings.Contains(q, "status=") {
		t.Fatalf("invalid numeric filters must be skipped: %s", q)
	}
}

func TestParseListPage(t *testing.T) {
	t.Parallel()
	limit, offset := parseListPage(url.Values{"limit": {"10"}, "offset": {"20"}})
	if limit != 10 || offset != 20 {
		t.Fatalf("expected 10/20, got %d/%d", limit, offset)
	}
	limit, offset = parseListPage(url.Values{})
	if limit != 50 || offset != 0 {
		t.Fatalf("defaults must be 50/0, got %d/%d", limit, offset)
	}
	limit, _ = parseListPage(url.Values{"limit": {"99999"}})
	if limit != maxPageSize {
		t.Fatalf("limit must be capped at %d, got %d", maxPageSize, limit)
	}
}

func TestSlicePageEmpty(t *testing.T) {
	t.Parallel()
	got := slicePage(nil, 0, 50)
	if len(got) != 0 {
		t.Fatalf("empty input must give empty page, got %d", len(got))
	}
}

func TestSlicePageSkipsBrokenLines(t *testing.T) {
	t.Parallel()
	lines := []entry{
		{ts: "3", line: `{"entity":"project","action":"create"}`},
		{ts: "2", line: "not json"},
		{ts: "1", line: `{"entity":"user","action":"update"}`},
	}
	views := slicePage(lines, 0, 50)
	if len(views) != 2 {
		t.Fatalf("broken line must be skipped, got %d views", len(views))
	}
	if views[0].Entity != "project" || views[0].ID != 1 {
		t.Fatalf("first view wrong: %+v", views[0])
	}
}
