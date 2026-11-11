//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	stderrors "errors"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	"github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
	errapi "github.com/Koshsky/erp-backend/pkg/errors"
)

type UserRepository struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	db     *sqlc.Queries
}

// NewUserRepository builds the UserRepository repository.
func NewUserRepository(logger *slog.Logger, pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{
		logger: logger.With("component", "user_repository"),
		pool:   pool,
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *UserRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

func (r *UserRepository) FindUserByUsername(ctx context.Context, username string) (*sqlc.User, error) {
	row, err := r.q(ctx).FindUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *UserRepository) UsernameExists(ctx context.Context, username string) (bool, error) {
	return r.q(ctx).UsernameExists(ctx, username)
}

func (r *UserRepository) FindUserByID(ctx context.Context, userID int64) (*sqlc.User, error) {
	return r.FindUser(ctx, userID)
}

func (r *UserRepository) UpdatePassword(ctx context.Context, userID int64, hash string) error {
	return r.q(ctx).UpdateUserPassword(ctx, sqlc.UpdateUserPasswordParams{
		UserID:       userID,
		PasswordHash: hash,
	})
}

func (r *UserRepository) DeleteUser(ctx context.Context, id int64) error {
	return mapUserDeleteErr(r.q(ctx).DeleteUser(ctx, id))
}

// UserReferences returns the counts of records that reference the user and
// block deletion (managees, owned resources/projects/processes/tasks, comment
// authorship, auto-create template owners).
func (r *UserRepository) UserReferences(ctx context.Context, id int64) (sqlc.ListUserReferencesRow, error) {
	return r.q(ctx).ListUserReferences(ctx, id)
}

func (r *UserRepository) CreateUser(ctx context.Context, user sqlc.User) (*sqlc.User, error) {
	row, err := r.q(ctx).CreateUser(ctx, sqlc.CreateUserParams{
		LastName:        user.LastName,
		FirstName:       user.FirstName,
		MiddleName:      user.MiddleName,
		Username:        user.Username,
		Preset:          user.Preset,
		PasswordHash:    user.PasswordHash,
		ManagerID:       user.ManagerID,
		Position:        user.Position,
		HireDate:        user.HireDate,
		TerminationDate: user.TerminationDate,
	})
	if err != nil {
		return nil, mapUserErr(err)
	}

	return &row, nil
}

// CreateUserWithPermissions creates the user and its individual permission
// overrides in a single transaction (the account and its rights appear
// together; on any error nothing is persisted).
func (r *UserRepository) CreateUserWithPermissions(
	ctx context.Context,
	user sqlc.User,
	perms []domain.UserPermission,
	updatedBy int64,
) (*sqlc.User, error) {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return nil, err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	row, err := q.CreateUser(ctx, sqlc.CreateUserParams{
		LastName:        user.LastName,
		FirstName:       user.FirstName,
		MiddleName:      user.MiddleName,
		Username:        user.Username,
		Preset:          user.Preset,
		PasswordHash:    user.PasswordHash,
		ManagerID:       user.ManagerID,
		Position:        user.Position,
		HireDate:        user.HireDate,
		TerminationDate: user.TerminationDate,
	})
	if err != nil {
		return nil, mapUserErr(err)
	}
	for _, p := range perms {
		if err = q.InsertUserPermission(ctx, sqlc.InsertUserPermissionParams{
			UserID:    row.ID,
			Resource:  p.Resource,
			Action:    p.Action,
			Scope:     p.Scope,
			Granted:   p.Granted,
			UpdatedBy: pgtypeInt8(updatedBy),
		}); err != nil {
			return nil, err
		}
	}
	if owned {
		if err = tx.Commit(ctx); err != nil {
			return nil, err
		}
	}

	return &row, nil
}

func (r *UserRepository) FindUser(ctx context.Context, id int64) (*sqlc.User, error) {
	row, err := r.q(ctx).FindUser(ctx, id)
	if err != nil {
		return nil, err
	}

	return &row, nil
}

// ListUserManagers returns the (id, manager_id) owner pairs of the requested
// users in a single query (the batch scope check — replaces one FindUser round
// trip per requested id).
func (r *UserRepository) ListUserManagers(ctx context.Context, userIDs []int64) ([]sqlc.ListUsersByIDsRow, error) {
	return r.q(ctx).ListUsersByIDs(ctx, userIDs)
}

func (r *UserRepository) UpdateUser(ctx context.Context, user sqlc.User) (*sqlc.User, error) {
	row, err := r.q(ctx).UpdateUser(ctx, sqlc.UpdateUserParams{
		UserID:          user.ID,
		LastName:        user.LastName,
		FirstName:       user.FirstName,
		MiddleName:      user.MiddleName,
		Username:        user.Username,
		Preset:          user.Preset,
		PasswordHash:    user.PasswordHash,
		ManagerID:       user.ManagerID,
		Position:        user.Position,
		HireDate:        user.HireDate,
		TerminationDate: user.TerminationDate,
	})
	if err != nil {
		return nil, mapUserErr(err)
	}

	return &row, nil
}

func (r *UserRepository) ListUsers(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	presetFilter string,
	managerID int64,
	search string,
	limit, offset int,
) ([]sqlc.User, error) {
	return r.q(ctx).ListUsers(ctx, sqlc.ListUsersParams{
		PresetFilter: presetFilter,
		ScAll:        scope.All,
		ScSelf:       scope.Self,
		ScNone:       scope.None,
		UserID:       userID,
		ManagerID:    managerID,
		Search:       search,
		PageLimit:    int64(limit),
		PageOffset:   int64(offset),
	})
}

func (r *UserRepository) CountUsers(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	presetFilter string,
	managerID int64,
	search string,
) (int64, error) {
	return r.q(ctx).CountUsers(ctx, sqlc.CountUsersParams{
		PresetFilter: presetFilter,
		ScAll:        scope.All,
		ScSelf:       scope.Self,
		ScNone:       scope.None,
		UserID:       userID,
		ManagerID:    managerID,
		Search:       search,
	})
}

func (r *UserRepository) ListAllUsers(ctx context.Context) ([]sqlc.User, error) {
	return r.q(ctx).ListAllUsers(ctx)
}

// ================= worker days (user_states) =================

func (r *UserRepository) ListStates(
	ctx context.Context,
	userID int64,
	start, end date.Date,
) ([]sqlc.ListStatesByUserRangeRow, error) {
	return r.q(ctx).ListStatesByUserRange(ctx, sqlc.ListStatesByUserRangeParams{
		UserID:    userID,
		StartDate: start,
		EndDate:   end,
	})
}

// ListStatesByUsers returns the states of several workers over one date range in
// a single query (batch variant of ListStates — avoids one request per employee).
// Rows come ordered by user_id, start_date, so the caller groups them in order.
func (r *UserRepository) ListStatesByUsers(
	ctx context.Context,
	userIDs []int64,
	start, end date.Date,
) ([]sqlc.ListStatesByUsersRangeRow, error) {
	return r.q(ctx).ListStatesByUsersRange(ctx, sqlc.ListStatesByUsersRangeParams{
		UserIds:   userIDs,
		StartDate: start,
		EndDate:   end,
	})
}

// overlapState is an overlapping interval with its state.
type overlapState struct {
	StateID   int64
	StartDate time.Time
	EndDate   time.Time
}

// SetStateRange overwrites the [start, end] range with the given state:
// subtracts [start, end] from overlapping intervals (keeping their residues),
// deletes covered ones and inserts the new one.
func (r *UserRepository) SetStateRange(
	ctx context.Context,
	userID, stateID int64,
	start, end date.Date,
) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	if err = lockUserStates(ctx, tx, userID); err != nil {
		return err
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	rows, err := q.ListOverlappingStates(ctx, sqlc.ListOverlappingStatesParams{
		UserID:    userID,
		StartDate: start,
		EndDate:   end,
	})
	if err != nil {
		return err
	}
	if err = q.DeleteOverlapping(ctx, sqlc.DeleteOverlappingParams{
		UserID:    userID,
		StartDate: start,
		EndDate:   end,
	}); err != nil {
		return err
	}
	if err = insertResidues(ctx, q, userID, toOverlapStates(rows), start.Time(), end.Time()); err != nil {
		return err
	}
	if _, err = q.InsertStateRange(ctx, sqlc.InsertStateRangeParams{
		UserID:    userID,
		StateID:   stateID,
		StartDate: start,
		EndDate:   end,
	}); err != nil {
		return err
	}

	// Merge adjacent/overlapping ranges of the same state into a continuous one:
	// fn_normalize_user_states() collapses neighboring intervals with the same
	// (user_id, state_id) right within this transaction.
	if err = q.NormalizeUserStates(ctx); err != nil {
		return err
	}

	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// DeleteStateRange clears the [start, end] range (keeping residues of
// overlapping intervals); with stateID != nil, only states of that type.
func (r *UserRepository) DeleteStateRange(
	ctx context.Context,
	userID int64,
	start, end date.Date,
	stateID *int64,
) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	if err = lockUserStates(ctx, tx, userID); err != nil {
		return err
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	var overlaps []overlapState
	if stateID == nil {
		overlaps, err = loadAndDeleteAll(ctx, q, userID, start, end)
	} else {
		overlaps, err = loadAndDeleteByState(ctx, q, userID, *stateID, start, end)
	}
	if err != nil {
		return err
	}
	if err = insertResidues(ctx, q, userID, overlaps, start.Time(), end.Time()); err != nil {
		return err
	}

	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// lockUserStates serializes state-range writes for one user inside the calling
// transaction (released automatically on commit/rollback). Without it, two
// concurrent SetStateRange/DeleteStateRange calls for the same user can both
// pass the overlap read and then one violates the EXCLUDE constraint (23P01)
// at insert time; the advisory lock turns that race into a clean serialized
// write (the mapped error stays 409 for genuinely conflicting input).
func lockUserStates(ctx context.Context, tx pgx.Tx, userID int64) error {
	_, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(hashtext('user_states:' || $1::bigint))", userID)
	return err
}

// loadAndDeleteAll loads and deletes all intervals overlapping [start, end].
func loadAndDeleteAll(
	ctx context.Context,
	q *sqlc.Queries,
	userID int64,
	start, end date.Date,
) ([]overlapState, error) {
	rows, err := q.ListOverlappingStates(ctx, sqlc.ListOverlappingStatesParams{
		UserID:    userID,
		StartDate: start,
		EndDate:   end,
	})
	if err != nil {
		return nil, err
	}
	return toOverlapStates(rows), q.DeleteOverlapping(ctx, sqlc.DeleteOverlappingParams{
		UserID:    userID,
		StartDate: start,
		EndDate:   end,
	})
}

// loadAndDeleteByState loads and deletes intervals of the given state overlapping [start, end].
func loadAndDeleteByState(
	ctx context.Context,
	q *sqlc.Queries,
	userID, stateID int64,
	start, end date.Date,
) ([]overlapState, error) {
	rows, err := q.ListOverlappingStatesByState(ctx, sqlc.ListOverlappingStatesByStateParams{
		UserID:    userID,
		StateID:   stateID,
		StartDate: start,
		EndDate:   end,
	})
	if err != nil {
		return nil, err
	}
	return toOverlapStatesByState(rows), q.DeleteOverlappingByState(ctx, sqlc.DeleteOverlappingByStateParams{
		UserID:    userID,
		StateID:   stateID,
		StartDate: start,
		EndDate:   end,
	})
}

// insertResidues inserts the parts of overlapping intervals outside [start, end]
// (left/right residues), keeping their original state.
func insertResidues(
	ctx context.Context,
	q *sqlc.Queries,
	userID int64,
	overlaps []overlapState,
	start, end time.Time,
) error {
	for _, o := range overlaps {
		if o.StartDate.Before(start) {
			if _, err := q.InsertStateRange(ctx, sqlc.InsertStateRangeParams{
				UserID:    userID,
				StateID:   o.StateID,
				StartDate: date.From(o.StartDate),
				EndDate:   date.From(start.AddDate(0, 0, -1)),
			}); err != nil {
				return err
			}
		}
		if o.EndDate.After(end) {
			if _, err := q.InsertStateRange(ctx, sqlc.InsertStateRangeParams{
				UserID:    userID,
				StateID:   o.StateID,
				StartDate: date.From(end.AddDate(0, 0, 1)),
				EndDate:   date.From(o.EndDate),
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func toOverlapStates(rows []sqlc.ListOverlappingStatesRow) []overlapState {
	result := make([]overlapState, 0, len(rows))
	for _, row := range rows {
		result = append(result, overlapState{
			StateID:   row.StateID,
			StartDate: row.StartDate.Time(),
			EndDate:   row.EndDate.Time(),
		})
	}
	return result
}

func toOverlapStatesByState(rows []sqlc.ListOverlappingStatesByStateRow) []overlapState {
	result := make([]overlapState, 0, len(rows))
	for _, row := range rows {
		result = append(result, overlapState{
			StateID:   row.StateID,
			StartDate: row.StartDate.Time(),
			EndDate:   row.EndDate.Time(),
		})
	}
	return result
}

// pgtypeInt8 wraps an int64 into a NOT-NULL pgtype.Int8.
func pgtypeInt8(v int64) pgtype.Int8 {
	return pgtype.Int8{Int64: v, Valid: true}
}

// OwnerChain returns the owner chain (manager_id → the vp) for RBAC checks.
func (r *UserRepository) OwnerChain(ctx context.Context, id int64) (rbac.Owners, error) {
	owner, err := r.q(ctx).OwnerChain(ctx, id)
	if err != nil {
		return rbac.Owners{}, err
	}
	return rbac.Owners{Owner: owner}, nil
}

// mapUserErr — a wrapper over errapi.MapPgConstraint: clear 4xx for
// constraint errors (unique login 409, role/manager FK 400, CHECK 400).
func mapUserErr(err error) error {
	return errapi.MapPgConstraint(err)
}

// mapUserDeleteErr turns the FK violation raised when a referenced user is
// deleted (Postgres picks one of the RESTRICT constraints — resources,
// comments, projects/processes/tasks ownership, manager_id) into a 409.
func mapUserDeleteErr(err error) error {
	var pgErr *pgconn.PgError
	if stderrors.As(err, &pgErr) && pgErr.Code == "23503" {
		return errapi.Conflict(
			"пользователя нельзя удалить: на него ссылаются связанные записи — сначала переназначьте или удалите их",
		)
	}
	return mapUserErr(err)
}
