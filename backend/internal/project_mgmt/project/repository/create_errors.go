package repository

import (
	stderrors "errors"

	"github.com/jackc/pgx/v5/pgconn"

	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

// mapProjectCreateError turns database-integrity failures of the project
// INSERT into user-friendly domain errors. FK failures during the insert come
// either from the project's own owner reference (a bad owner_id in the
// request) or from the auto-create template applied by the DB trigger (V8): a
// template-referenced resource/owner may have been deleted after the template
// was saved — the project itself is valid, the template is stale. All other
// integrity errors keep the generic mapping.
func mapProjectCreateError(err error) error {
	var pgErr *pgconn.PgError
	if !stderrors.As(err, &pgErr) || pgErr.Code != "23503" {
		return errapi.MapPgConstraint(err)
	}
	switch pgErr.ConstraintName {
	case "projects_owner_id_fkey":
		return errapi.BadRequest("указанный владелец проекта не найден")
	case "processes_owner_id_fkey", "assignments_resource_id_fkey":
		return errapi.BadRequest(
			"не удалось применить шаблон автосоздания: ресурсы или владельцы в шаблоне больше недоступны — обновите шаблон на странице «Автосоздание проектов»",
		)
	default:
		return errapi.MapPgConstraint(err)
	}
}
