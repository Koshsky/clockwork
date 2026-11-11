package errors_test

import (
	stdErrors "errors"
	"net/http"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"

	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

func TestConflictCodeAndStatus(t *testing.T) {
	t.Parallel()
	err := errapi.Conflict("project with this code already exists")

	var de *errapi.DomainError
	if !stdErrors.As(err, &de) {
		t.Fatalf("Conflict() returned %T, want *DomainError", err)
	}
	if de.StatusCode() != http.StatusConflict {
		t.Fatalf("StatusCode = %d, want %d", de.StatusCode(), http.StatusConflict)
	}
	if de.ErrorCode() != errapi.CodeConflict {
		t.Fatalf("ErrorCode = %s, want %s", de.ErrorCode(), errapi.CodeConflict)
	}
	if de.Code.String() != "CONFLICT" {
		t.Fatalf("wire code = %q, want %q", de.Code.String(), "CONFLICT")
	}
}

func TestCodeForConflictStatus(t *testing.T) {
	t.Parallel()
	if got := errapi.CodeFor(http.StatusConflict); got != errapi.CodeConflict {
		t.Fatalf("CodeFor(409) = %s, want %s", got, errapi.CodeConflict)
	}
}

func TestConflictIsSentinel(t *testing.T) {
	t.Parallel()
	if !errapi.IsConflictError(errapi.Conflict("collision")) {
		t.Fatalf("IsConflictError(Conflict()) = false, want true")
	}
}

func TestStatusCodeMapsConflict(t *testing.T) {
	t.Parallel()
	if got := errapi.StatusCode(errapi.Conflict("x")); got != http.StatusConflict {
		t.Fatalf("StatusCode(Conflict) = %d, want %d", got, http.StatusConflict)
	}
}

func TestFromPgInvalidParam(t *testing.T) {
	t.Parallel()
	pgErr := &pgconn.PgError{Code: "22023", Message: "Сроки процесса выходят за границы проекта"}
	got := errapi.FromPgInvalidParam(pgErr)
	if errapi.StatusCode(got) != http.StatusBadRequest {
		t.Fatalf("StatusCode = %d, want 400", errapi.StatusCode(got))
	}
	// The raw DB message must not reach the client body (S1); it is kept as
	// the server-side log detail.
	if got.Error() == pgErr.Message {
		t.Errorf("raw DB message leaked into the response body: %q", got.Error())
	}
	if de := domainError(t, got); de.Details != pgErr.Message {
		t.Errorf("Details = %q, want %q (kept for the server-side log)", de.Details, pgErr.Message)
	}
	// Other codes and foreign errors pass through unchanged.
	other := &pgconn.PgError{Code: "23505", Message: "dup"}
	if !stdErrors.Is(errapi.FromPgInvalidParam(other), other) {
		t.Errorf("23505 must not be mapped")
	}
	sentinel := stdErrors.New("boom")
	if !stdErrors.Is(errapi.FromPgInvalidParam(sentinel), sentinel) {
		t.Errorf("foreign error must not be mapped")
	}
}

func TestMapPgConstraint(t *testing.T) {
	t.Parallel()
	// 23505 unique (username) -> 409
	dup := errapi.MapPgConstraint(&pgconn.PgError{Code: "23505", ConstraintName: "users_username_unique_active"})
	if errapi.StatusCode(dup) != http.StatusConflict {
		t.Errorf("23505: StatusCode = %d, want 409", errapi.StatusCode(dup))
	}
	// 23P01 exclusion (overlapping user_state ranges) -> 409 + wire code
	excl := errapi.MapPgConstraint(&pgconn.PgError{Code: "23P01", ConstraintName: "user_states_excl"})
	var de *errapi.DomainError
	if !stdErrors.As(excl, &de) || de.StatusCode() != http.StatusConflict || de.ErrorCode() != errapi.CodeConflict {
		t.Errorf("23P01: got %v, want 409 CONFLICT", excl)
	}
	// 23503 role fk -> 400 "unknown role"
	role := errapi.MapPgConstraint(&pgconn.PgError{Code: "23503", ConstraintName: "users_role_fk"})
	if errapi.StatusCode(role) != http.StatusBadRequest || !strings.Contains(role.Error(), "каталоге ролей") {
		t.Errorf("23503 role: got %v", role)
	}
	// 23514 check -> 400; 23503 generic fk -> 400; neither leaks the
	// constraint name into the body (S1) — it is kept as the log detail.
	chk := errapi.MapPgConstraint(&pgconn.PgError{Code: "23514", ConstraintName: "tasks_dates_check"})
	if errapi.StatusCode(chk) != http.StatusBadRequest {
		t.Errorf("23514: StatusCode = %d, want 400", errapi.StatusCode(chk))
	}
	de = domainError(t, chk)
	if de.Details != "tasks_dates_check" {
		t.Errorf("23514 Details = %q, want %q", de.Details, "tasks_dates_check")
	}
	if strings.Contains(chk.Error(), "tasks_dates_check") {
		t.Errorf("23514: constraint name leaked into the body: %q", chk.Error())
	}
	genericFK := errapi.MapPgConstraint(&pgconn.PgError{Code: "23503", ConstraintName: "users_manager_fk"})
	de = domainError(t, genericFK)
	if de.Details != "users_manager_fk" {
		t.Errorf("23503 Details = %q, want %q", de.Details, "users_manager_fk")
	}
	if strings.Contains(genericFK.Error(), "users_manager_fk") {
		t.Errorf("23503: constraint name leaked into the body: %q", genericFK.Error())
	}
	// foreign errors pass through unchanged
	other := &pgconn.PgError{Code: "22023", Message: "x"}
	if !stdErrors.Is(errapi.MapPgConstraint(other), other) {
		t.Errorf("22023 must not be mapped")
	}
	sentinel := stdErrors.New("boom")
	if !stdErrors.Is(errapi.MapPgConstraint(sentinel), sentinel) {
		t.Errorf("foreign error must not be mapped")
	}
}

// domainError unwraps a *DomainError for assertion helpers.
func domainError(t *testing.T, err error) *errapi.DomainError {
	t.Helper()
	var de *errapi.DomainError
	if !stdErrors.As(err, &de) {
		t.Fatalf("got %T, want *DomainError", err)
	}
	return de
}

func TestStatusCodeClassifiesExclusionViolation(t *testing.T) {
	t.Parallel()
	// A raw 23P01 (not wrapped by MapPgConstraint) must still map to 409 so
	// handlers using response.Error do not surface it as an unmapped 500.
	raw := &pgconn.PgError{Code: "23P01", ConstraintName: "user_states_excl"}
	if got := errapi.StatusCode(raw); got != http.StatusConflict {
		t.Errorf("StatusCode(23P01) = %d, want 409", got)
	}
	if !errapi.IsConflictError(raw) {
		t.Error("IsConflictError(23P01) = false, want true")
	}
}
