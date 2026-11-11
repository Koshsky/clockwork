package service //nolint:testpackage // tests exercise unexported helpers (normalizeSearch, dedupeIDs)

import "testing"

// TestNormalizeSearch covers the user-list search pattern: lowercasing,
// trimming, LIKE-metacharacter escaping (an injected % must not turn into
// "match everything") and the empty result for a pattern with no searchable
// character.
func TestNormalizeSearch(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "empty", in: "", want: ""},
		{name: "spaces only", in: "   ", want: ""},
		{name: "lowercased and trimmed", in: "  Иванов  ", want: "иванов"},
		{name: "latin login", in: "Worker_1", want: "worker\\_1"},
		{name: "percent is escaped", in: "100%", want: "100\\%"},
		{name: "underscore is escaped", in: "a_b", want: "a\\_b"},
		{name: "backslash is escaped", in: "a\\b", want: "a\\\\b"},
		{name: "wildcard only is dropped", in: "%", want: ""},
		{name: "wildcard mix only is dropped", in: "%_%", want: ""},
		{name: "wildcard with text survives", in: "%иван%", want: "\\%иван\\%"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := normalizeSearch(tt.in); got != tt.want {
				t.Fatalf("normalizeSearch(%q) = %q, want %q", tt.in, got, tt.want)
			}
		})
	}
}

// TestValidateSearchLength checks the length cap: a pattern longer than the
// limit is rejected, an oversized-but-blank pattern is not.
func TestValidateSearchLength(t *testing.T) {
	t.Parallel()

	v := &UserValidator{}
	long := make([]byte, maxSearchLen+1)
	for i := range long {
		long[i] = 'a'
	}

	if _, err := v.ValidateSearch(string(long)); err == nil {
		t.Fatal("expected an error for an oversized search pattern")
	}
	if _, err := v.ValidateSearch("  " + string(long[:maxSearchLen]) + "  "); err != nil {
		t.Fatalf("pattern of max length (plus padding) rejected: %v", err)
	}
}

// TestValidatePositiveIDs checks the batch ids rule: non-empty, bounded, all positive.
func TestValidatePositiveIDs(t *testing.T) {
	t.Parallel()

	v := &UserValidator{}
	if err := v.ValidatePositiveIDs(nil, "ids"); err == nil {
		t.Fatal("expected an error for an empty id list")
	}
	if err := v.ValidatePositiveIDs([]int64{1, 2}, "ids"); err != nil {
		t.Fatalf("valid id list rejected: %v", err)
	}
	if err := v.ValidatePositiveIDs([]int64{1, 0}, "ids"); err == nil {
		t.Fatal("expected an error for a non-positive id")
	}

	tooMany := make([]int64, maxBatchIDs+1)
	for i := range tooMany {
		tooMany[i] = int64(i + 1)
	}
	if err := v.ValidatePositiveIDs(tooMany, "ids"); err == nil {
		t.Fatal("expected an error for an oversized id list")
	}
}

// TestDedupeIDs checks order-preserving deduplication of requested worker ids.
func TestDedupeIDs(t *testing.T) {
	t.Parallel()

	got := dedupeIDs([]int64{3, 1, 3, 2, 1})
	want := []int64{3, 1, 2}
	if len(got) != len(want) {
		t.Fatalf("dedupeIDs = %v, want %v", got, want)
	}
	for i := range got {
		if got[i] != want[i] {
			t.Fatalf("dedupeIDs = %v, want %v", got, want)
		}
	}
}
