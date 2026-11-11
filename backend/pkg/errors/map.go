package errors

import (
	"strings"

	stderrors "errors"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/Koshsky/erp-backend/pkg/messages"
)

// MapPgConstraint maps a Postgres integrity violation into a domain error:
// unique (23505) → 409, foreign key (23503) → 400, CHECK (23514) → 400,
// exclusion (23P01, overlapping ranges such as user_states) → 409.
// All other errors are returned unchanged.
//
// The response message is always a fixed human-readable text — the constraint
// name is internal detail and is attached as Details for the server-side log
// only, never echoed to the client.
func MapPgConstraint(err error) error {
	var pgErr *pgconn.PgError
	if !stderrors.As(err, &pgErr) {
		return err
	}
	switch pgErr.Code {
	case "23505":
		return withDetail(ConflictM(uniqueMessage(pgErr.ConstraintName)), pgErr.ConstraintName)
	case "23P01":
		return withDetail(Conflict("значение пересекается с существующим диапазоном"), pgErr.ConstraintName)
	case "23503":
		if pgErr.ConstraintName == "users_role_fk" {
			return withDetail(BadRequest("неизвестная роль: её нет в каталоге ролей"), pgErr.ConstraintName)
		}
		return withDetail(BadRequest("запись ссылается на несуществующий объект"), pgErr.ConstraintName)
	case "23514":
		return withDetail(BadRequest("значение не прошло проверку базы данных"), pgErr.ConstraintName)
	default:
		return err
	}
}

// uniqueMessage picks the parameterized message for 23505 from the constraint
// name (e.g. the partial unique index on the user login).
func uniqueMessage(constraint string) messages.Message {
	if strings.Contains(constraint, "username") {
		return messages.M("errors.unique_username")
	}
	return messages.M("errors.unique_generic")
}
