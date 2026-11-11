package errors

import (
	stderrors "errors"

	"github.com/jackc/pgx/v5/pgconn"
)

// FromPgInvalidParam maps a Postgres error with code 22023
// (invalid_parameter_value — dates exceeding a parent's bounds, raised by the
// V3 validation triggers) into a 400 error. The response body carries a fixed
// friendly message; the trigger's own message (raw DB text) is attached as
// Details for the server-side log only. All other errors are returned unchanged.
func FromPgInvalidParam(err error) error {
	var pgErr *pgconn.PgError
	if stderrors.As(err, &pgErr) && pgErr.Code == "22023" {
		return withDetail(BadRequest("указанные даты выходят за границы допустимого диапазона"), pgErr.Message)
	}
	return err
}
