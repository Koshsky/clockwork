//nolint:testpackage // constraint helpers (boundDate/anchorDate/checkConstraint) are unexported
package service

import (
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/project_mgmt/task_dependency/domain"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// dates is a small helper for the test table.
func d(s, e string) (date.Date, date.Date) { return date.Date(s), date.Date(e) }

// TestConstraintMatrix pins the 4×2 bound/anchor semantics: for every type,
// the successor's bound date (start for fs/ss, end for ff/sf) must not be
// earlier than the predecessor's anchor date (end for fs/ff, start for ss/sf).
func TestConstraintMatrix(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name        string
		typ         string
		taskStart   date.Date
		taskEnd     date.Date
		predStart   date.Date
		predEnd     date.Date
		wantViolate bool
	}{
		// fs — successor starts after predecessor ends.
		{
			name:        "fs satisfied (equal)",
			typ:         domain.TypeFinishToStart,
			taskStart:   "2026-02-01",
			taskEnd:     "2026-02-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-02-01",
			wantViolate: false,
		},
		{
			name:        "fs violated (start before pred end)",
			typ:         domain.TypeFinishToStart,
			taskStart:   "2026-01-15",
			taskEnd:     "2026-02-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-02-01",
			wantViolate: true,
		},
		{
			name:        "fs satisfied (late start)",
			typ:         domain.TypeFinishToStart,
			taskStart:   "2026-03-01",
			taskEnd:     "2026-03-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-02-01",
			wantViolate: false,
		},

		// ss — successor starts after predecessor starts.
		{
			name:        "ss satisfied (equal)",
			typ:         domain.TypeStartToStart,
			taskStart:   "2026-01-01",
			taskEnd:     "2026-02-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-01-20",
			wantViolate: false,
		},
		{
			name:        "ss violated (start before pred start)",
			typ:         domain.TypeStartToStart,
			taskStart:   "2025-12-30",
			taskEnd:     "2026-02-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-01-20",
			wantViolate: true,
		},

		// ff — successor ends after predecessor ends.
		{
			name:        "ff satisfied (equal)",
			typ:         domain.TypeFinishToFinish,
			taskStart:   "2026-01-01",
			taskEnd:     "2026-02-10",
			predStart:   "2026-01-01",
			predEnd:     "2026-02-10",
			wantViolate: false,
		},
		{
			name:        "ff violated (end before pred end)",
			typ:         domain.TypeFinishToFinish,
			taskStart:   "2026-01-01",
			taskEnd:     "2026-01-30",
			predStart:   "2026-01-01",
			predEnd:     "2026-02-10",
			wantViolate: true,
		},

		// sf — successor ends after predecessor starts.
		{
			name:        "sf satisfied (equal)",
			typ:         domain.TypeStartToFinish,
			taskStart:   "2026-01-01",
			taskEnd:     "2026-01-05",
			predStart:   "2026-01-05",
			predEnd:     "2026-02-10",
			wantViolate: false,
		},
		{
			name:        "sf violated (end before pred start)",
			typ:         domain.TypeStartToFinish,
			taskStart:   "2026-01-01",
			taskEnd:     "2026-01-04",
			predStart:   "2026-01-05",
			predEnd:     "2026-02-10",
			wantViolate: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := checkConstraint("B", tc.taskStart, tc.taskEnd, tc.typ, "A", tc.predStart, tc.predEnd)
			if tc.wantViolate {
				if err == nil {
					t.Fatalf("checkConstraint(%s) = nil; want a violation", tc.typ)
				}
				if !errors.IsValidationError(err) {
					t.Fatalf("checkConstraint(%s) = %v; want a validation error", tc.typ, err)
				}
				return
			}
			if err != nil {
				t.Fatalf("checkConstraint(%s) = %v; want nil", tc.typ, err)
			}
		})
	}
}

// TestViolationMessageNamesTasks ensures the user-facing message carries both
// task titles in either language.
func TestViolationMessageNamesTasks(t *testing.T) {
	t.Parallel()
	for _, typ := range []string{domain.TypeFinishToStart, domain.TypeStartToStart, domain.TypeFinishToFinish, domain.TypeStartToFinish} {
		m := violationTemplate(typ, "Монтаж", "Подготовка")
		ru := m.Text(messages.LocaleRU)
		if ru == "" {
			t.Fatalf("violationTemplate(%s) RU пуст", typ)
		}
		if !strings.Contains(ru, "Монтаж") || !strings.Contains(ru, "Подготовка") {
			t.Errorf("violationTemplate(%s) RU = %q; want both task titles", typ, ru)
		}
		en := m.Text(messages.LocaleEN)
		if !strings.Contains(en, "Монтаж") || !strings.Contains(en, "Подготовка") {
			t.Errorf("violationTemplate(%s) EN = %q; want both task titles", typ, en)
		}
	}
}

// TestValidateLinkSemantics pins the bound/anchor date selection per type.
func TestBoundAnchorSemantics(t *testing.T) {
	t.Parallel()
	start, end := d("2026-01-01", "2026-02-01")
	ps, pe := d("2026-01-10", "2026-02-10")

	if got := boundDate(domain.TypeFinishToStart, start, end); got != start {
		t.Errorf("boundDate(fs) = %q; want task start", got)
	}
	if got := boundDate(domain.TypeFinishToFinish, start, end); got != end {
		t.Errorf("boundDate(ff) = %q; want task end", got)
	}
	if got := anchorDate(domain.TypeFinishToStart, ps, pe); got != pe {
		t.Errorf("anchorDate(fs) = %q; want pred end", got)
	}
	if got := anchorDate(domain.TypeStartToStart, ps, pe); got != ps {
		t.Errorf("anchorDate(ss) = %q; want pred start", got)
	}
	if got := anchorDate(domain.TypeStartToFinish, ps, pe); got != ps {
		t.Errorf("anchorDate(sf) = %q; want pred start", got)
	}
}
