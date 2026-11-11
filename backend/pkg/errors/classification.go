package errors

import (
	"database/sql"
	"net/http"

	stderrors "errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// IsNotFoundError reports whether the error is a missing entity: our ErrNotFound
// sentinel or a raw pgx/sql no-rows error.
func IsNotFoundError(err error) bool {
	return stderrors.Is(err, ErrNotFound) ||
		stderrors.Is(err, pgx.ErrNoRows) ||
		stderrors.Is(err, sql.ErrNoRows)
}

// IsForbidden reports whether the error is a permission denial.
func IsForbidden(err error) bool {
	return stderrors.Is(err, ErrForbidden)
}

// IsConflictError reports whether the error is a business-key conflict (409):
// our ErrConflict sentinel or a Postgres exclusion violation (23P01 — e.g.
// overlapping user_state ranges).
func IsConflictError(err error) bool {
	if stderrors.Is(err, ErrConflict) {
		return true
	}
	var pgErr *pgconn.PgError
	return stderrors.As(err, &pgErr) && pgErr.Code == "23P01"
}

// IsValidationError reports whether the error is a validation failure: our
// ErrValidation sentinel or a unique/foreign-key/check violation from the DB.
func IsValidationError(err error) bool {
	if stderrors.Is(err, ErrValidation) {
		return true
	}
	var pgErr *pgconn.PgError
	if !stderrors.As(err, &pgErr) {
		return false
	}
	// 23505 unique_violation, 23503 foreign_key_violation, 23514 check_violation
	return pgErr.Code == "23505" || pgErr.Code == "23503" || pgErr.Code == "23514"
}

// statusCoder is implemented by any error that knows its HTTP status.
type statusCoder interface {
	StatusCode() int
}

// StatusCode returns the HTTP status for an error. Errors that implement
// StatusCode (like DomainError and FieldError) are honored first; otherwise the
// error is classified by its cause (not found / forbidden / validation).
func StatusCode(err error) int {
	var sc statusCoder
	if stderrors.As(err, &sc) {
		return sc.StatusCode()
	}
	switch {
	case IsNotFoundError(err):
		return http.StatusNotFound
	case IsForbidden(err):
		return http.StatusForbidden
	case IsConflictError(err):
		return http.StatusConflict
	case IsValidationError(err):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}
