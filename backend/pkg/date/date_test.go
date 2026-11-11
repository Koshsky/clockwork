package date_test

import (
	"encoding/json"
	"testing"

	"github.com/Koshsky/erp-backend/pkg/date"
)

func TestDateRoundTrip(t *testing.T) {
	t.Parallel()

	d, err := date.Parse("2026-07-15")
	if err != nil {
		t.Fatal(err)
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != `"2026-07-15"` {
		t.Fatalf("marshal = %s", b)
	}
	var got date.Date
	err = json.Unmarshal(b, &got)
	if err != nil {
		t.Fatal(err)
	}
	if got != d {
		t.Fatalf("round-trip mismatch: %q", got)
	}
}

func TestDateUnmarshalRFC3339Compat(t *testing.T) {
	t.Parallel()

	var d date.Date
	if err := json.Unmarshal([]byte(`"2026-07-15T00:00:00Z"`), &d); err != nil {
		t.Fatal(err)
	}
	if d.String() != "2026-07-15" {
		t.Fatalf("got %q", d)
	}
}

// TestDateRejectsRFC3339WithDayShift guards against the silent UTC-midnight
// truncation (E4): an RFC3339 value whose UTC instant falls on another
// calendar day must be a parse error, never a silently shifted date.
func TestDateRejectsRFC3339WithDayShift(t *testing.T) {
	t.Parallel()

	for _, in := range []string{
		`"2026-01-01T00:30:00+03:00"`, // non-midnight time, UTC day shift (the reported defect)
		`"2026-01-01T00:00:00+03:00"`, // midnight but non-UTC offset, UTC day shift
	} {
		var d date.Date
		if err := json.Unmarshal([]byte(in), &d); err == nil {
			t.Fatalf("expected error for %s, got date %q", in, d)
		}
	}
}

// TestDateAcceptsRFC3339WithoutDayShift keeps the compatibility branch for
// values that do not shift the calendar date under UTC normalization.
func TestDateAcceptsRFC3339WithoutDayShift(t *testing.T) {
	t.Parallel()

	in := `"2026-01-01T00:30:00-03:00"` // same UTC day as written — no shift
	var d date.Date
	if err := json.Unmarshal([]byte(in), &d); err != nil {
		t.Fatalf("unexpected error for %s: %v", in, err)
	}
	if d.String() != "2026-01-01" {
		t.Fatalf("got %q", d)
	}
}

func TestDateRejectsBadFormat(t *testing.T) {
	t.Parallel()

	var d date.Date
	if err := json.Unmarshal([]byte(`"2026/07/15"`), &d); err == nil {
		t.Fatal("expected error")
	}
}

func TestDateTimeIsMidnightUTC(t *testing.T) {
	t.Parallel()

	d, err := date.Parse("2026-07-15")
	if err != nil {
		t.Fatal(err)
	}
	if got := d.Time(); got.UTC().Format(date.Layout) != "2026-07-15" {
		t.Fatalf("got %v", got)
	}
}
