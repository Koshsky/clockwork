//go:generate go run github.com/sqlc-dev/sqlc/cmd/sqlc@v1.27.0 generate -f ./sqlc.yaml
package repository

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/database"
)

// RuleRepository — access to configurable RBAC policies in Postgres.
type RuleRepository struct {
	logger *slog.Logger
	pool   *pgxpool.Pool
	db     *sqlc.Queries
}

// NewRuleRepository builds the rule repository.
func NewRuleRepository(logger *slog.Logger, pool *pgxpool.Pool) *RuleRepository {
	return &RuleRepository{
		logger: logger.With("component", "rbacpolicy_repository"),
		pool:   pool,
		db:     sqlc.New(pool),
	}
}

// q resolves the query handle: the request-scoped transaction when one is
// active (idempotency middleware), otherwise the shared pool.
func (r *RuleRepository) q(ctx context.Context) *sqlc.Queries {
	if tx, ok := database.TxFrom(ctx); ok {
		return sqlc.New(tx)
	}
	return r.db
}

// ListActivePresets returns the preset catalog.
func (r *RuleRepository) ListActivePresets(ctx context.Context) ([]sqlc.ListActivePresetsRow, error) {
	return r.q(ctx).ListActivePresets(ctx)
}

// ListActiveRules returns all active matrix rows.
func (r *RuleRepository) ListActiveRules(ctx context.Context) ([]sqlc.ListActivePresetRulesRow, error) {
	return r.q(ctx).ListActivePresetRules(ctx)
}

// UpsertRule writes (or updates) a matrix row by the unique key
// (preset, resource, action) and returns the stored row.
func (r *RuleRepository) UpsertRule(
	ctx context.Context,
	preset, resource, action, scope string,
	updatedBy *int64,
) (sqlc.UpsertPresetRuleRow, error) {
	return r.q(ctx).UpsertPresetRule(ctx, sqlc.UpsertPresetRuleParams{
		Preset:    preset,
		Resource:  resource,
		Action:    action,
		Scope:     scope,
		UpdatedBy: toInt8(updatedBy),
	})
}

// DeleteRule removes a matrix row (archived by the DB trigger).
func (r *RuleRepository) DeleteRule(ctx context.Context, id int64) error {
	return r.q(ctx).DeletePresetRule(ctx, id)
}

// DeleteAllRules removes every matrix row (for reset); each row is archived.
func (r *RuleRepository) DeleteAllRules(ctx context.Context) error {
	return r.q(ctx).DeleteAllPresetRules(ctx)
}

// ListActiveRoutePolicies returns all active route policy definitions.
func (r *RuleRepository) ListActiveRoutePolicies(ctx context.Context) ([]domain.RoutePolicy, error) {
	rows, err := r.q(ctx).ListActiveRoutePolicies(ctx)
	if err != nil {
		return nil, err
	}
	policies := make([]domain.RoutePolicy, 0, len(rows))
	for _, row := range rows {
		params := map[string]any{}
		if len(row.Params) > 0 {
			if unmarshalErr := json.Unmarshal(row.Params, &params); unmarshalErr != nil {
				return nil, unmarshalErr
			}
		}
		policies = append(policies, domain.RoutePolicy{
			Name:      row.Name,
			Kind:      row.Kind,
			Params:    params,
			Active:    row.Active,
			UpdatedBy: fromInt8(row.UpdatedBy),
			UpdatedAt: row.UpdatedAt,
		})
	}
	return policies, nil
}

// UpsertRoutePolicy writes (or updates) a route policy by name.
func (r *RuleRepository) UpsertRoutePolicy(ctx context.Context, p domain.RoutePolicy) (domain.RoutePolicy, error) {
	raw, err := json.Marshal(p.Params)
	if err != nil {
		return domain.RoutePolicy{}, err
	}
	row, err := r.q(ctx).UpsertRoutePolicy(ctx, sqlc.UpsertRoutePolicyParams{
		Name:      p.Name,
		Kind:      p.Kind,
		Params:    raw,
		Active:    p.Active,
		UpdatedBy: toInt8(p.UpdatedBy),
	})
	if err != nil {
		return domain.RoutePolicy{}, err
	}
	params := map[string]any{}
	if len(row.Params) > 0 {
		if unmarshalErr := json.Unmarshal(row.Params, &params); unmarshalErr != nil {
			return domain.RoutePolicy{}, unmarshalErr
		}
	}
	return domain.RoutePolicy{
		Name:      row.Name,
		Kind:      row.Kind,
		Params:    params,
		Active:    row.Active,
		UpdatedBy: fromInt8(row.UpdatedBy),
		UpdatedAt: row.UpdatedAt,
	}, nil
}

// DeleteRoutePolicy removes a route policy by name (archived).
func (r *RuleRepository) DeleteRoutePolicy(ctx context.Context, name string) error {
	return r.q(ctx).DeleteRoutePolicy(ctx, name)
}

// DeleteAllRoutePolicies removes every route policy (for reset); each is archived.
func (r *RuleRepository) DeleteAllRoutePolicies(ctx context.Context) error {
	return r.q(ctx).DeleteAllRoutePolicies(ctx)
}

// ResetPolicies replaces the whole matrix and route-policy sets in one
// transaction: every rule and route policy is deleted (archived) and the given
// default sets are re-inserted atomically. A failure anywhere rolls the
// transaction back, so the DB never lands half-reseeded; on success the whole
// new state is durable at once. When an ambient request-scoped transaction is
// present (idempotency middleware), the reset joins it and leaves the commit to
// the transaction owner.
func (r *RuleRepository) ResetPolicies(
	ctx context.Context,
	rules []sqlc.UpsertPresetRuleParams,
	policies []sqlc.UpsertRoutePolicyParams,
) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	if err = q.DeleteAllPresetRules(ctx); err != nil {
		return err
	}
	if err = q.DeleteAllRoutePolicies(ctx); err != nil {
		return err
	}
	for _, rule := range rules {
		if _, err = q.UpsertPresetRule(ctx, rule); err != nil {
			return err
		}
	}
	for _, policy := range policies {
		if _, err = q.UpsertRoutePolicy(ctx, policy); err != nil {
			return err
		}
	}
	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// UpsertPreset creates a preset (or updates it by tag).
func (r *RuleRepository) UpsertPreset(
	ctx context.Context,
	tag, name, description string,
) (sqlc.UpsertPresetRow, error) {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return sqlc.UpsertPresetRow{}, err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}
	q := sqlc.New(tx)
	preset, err := q.UpsertPreset(ctx, sqlc.UpsertPresetParams{Tag: tag, Name: name, Description: description})
	if err != nil {
		return sqlc.UpsertPresetRow{}, err
	}
	for _, resource := range []string{"resource", "project", "process", "task", "milestone", "assignment"} {
		scope := "self"
		if resource == "process" || resource == "task" || resource == "milestone" || resource == "assignment" {
			scope = "up1"
		}
		actions := []string{"view", "create", "update", "delete"}
		if resource == "project" {
			actions = append(actions, "prioritize")
		}
		for _, action := range actions {
			if _, err = q.UpsertPresetRule(
				ctx,
				sqlc.UpsertPresetRuleParams{Preset: tag, Resource: resource, Action: action, Scope: scope},
			); err != nil {
				return sqlc.UpsertPresetRow{}, err
			}
		}
	}
	if owned {
		if err = tx.Commit(ctx); err != nil {
			return sqlc.UpsertPresetRow{}, err
		}
	}
	return preset, nil
}

// UpdatePreset updates a preset: name and description always; a tag rename
// (newTag != tag) also moves its rules and the preset refs of assigned
// users — one transaction, so a rename never leaves the catalog inconsistent.
func (r *RuleRepository) UpdatePreset(
	ctx context.Context,
	tag, newTag, name, description string,
) (sqlc.RenamePresetRow, error) {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	if newTag != tag {
		if err = q.RenamePresetRules(ctx, sqlc.RenamePresetRulesParams{
			Tag: tag, NewTag: newTag,
		}); err != nil {
			return sqlc.RenamePresetRow{}, err
		}
		if err = q.RenamePresetUsers(ctx, sqlc.RenamePresetUsersParams{
			Tag: tag, NewTag: newTag,
		}); err != nil {
			return sqlc.RenamePresetRow{}, err
		}
	}
	row, err := q.RenamePreset(ctx, sqlc.RenamePresetParams{
		Tag: tag, NewTag: newTag, Name: name, Description: description,
	})
	if err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	if !owned {
		return row, nil
	}
	if err = tx.Commit(ctx); err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	return row, nil
}

// DeletePreset deletes a preset together with its rules and clears the preset
// ref on users (base rights vanish; individual overrides survive). The users
// ref must be cleared before the preset row is removed (FK users.preset →
// rbac_presets(tag) is RESTRICT).
func (r *RuleRepository) DeletePreset(ctx context.Context, tag string) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	if err = q.ClearPresetOnUsers(ctx, tag); err != nil {
		return err
	}
	if err = q.DeletePresetRulesByPreset(ctx, tag); err != nil {
		return err
	}
	if err = q.DeletePreset(ctx, tag); err != nil {
		return err
	}
	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// ListUserPermissions returns the active per-user overrides of a user.
func (r *RuleRepository) ListUserPermissions(ctx context.Context, userID int64) ([]sqlc.ListUserPermissionsRow, error) {
	return r.q(ctx).ListUserPermissions(ctx, userID)
}

// ReplaceUserPermissions atomically replaces the user's override set:
// deletes (archives) the previous rows and inserts the new ones.
func (r *RuleRepository) ReplaceUserPermissions(
	ctx context.Context,
	userID int64,
	perms []sqlc.InsertUserPermissionParams,
) error {
	tx, owned, err := database.BeginOrJoin(ctx, r.pool)
	if err != nil {
		return err
	}
	if owned {
		defer func() { _ = tx.Rollback(ctx) }()
	}

	q := r.q(ctx)
	if owned {
		q = sqlc.New(tx)
	}
	if err = q.DeleteAllUserPermissions(ctx, userID); err != nil {
		return err
	}
	for _, p := range perms {
		if _, err = q.InsertUserPermission(ctx, p); err != nil {
			return err
		}
	}
	if !owned {
		return nil
	}
	return tx.Commit(ctx)
}

// FindUserPreset returns the user's assigned preset and whether it is set
// (exists=false — the user has no preset).
func (r *RuleRepository) FindUserPreset(ctx context.Context, userID int64) (string, bool, error) {
	preset, err := r.q(ctx).FindUserPreset(ctx, userID)
	if err != nil {
		return "", false, err
	}
	if !preset.Valid {
		return "", false, nil
	}
	return preset.String, true, nil
}

// ListUserPrincipals returns the preset of every active user (user_id, preset)
// — the base of the in-memory principal snapshot.
func (r *RuleRepository) ListUserPrincipals(ctx context.Context) ([]UserPreset, error) {
	rows, err := r.q(ctx).ListUserPrincipals(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]UserPreset, 0, len(rows))
	for _, row := range rows {
		out = append(out, UserPreset{
			UserID: row.UserID,
			Preset: row.Preset,
		})
	}
	return out, nil
}

// ListAllUserPermissions returns every active per-user override (for the
// in-memory principal snapshot; grouped by the caller).
func (r *RuleRepository) ListAllUserPermissions(ctx context.Context) ([]UserPermissionRef, error) {
	rows, err := r.q(ctx).ListAllUserPermissions(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]UserPermissionRef, 0, len(rows))
	for _, row := range rows {
		out = append(out, UserPermissionRef{
			UserID:   row.UserID,
			Resource: row.Resource,
			Action:   row.Action,
			Scope:    row.Scope,
			Granted:  row.Granted,
		})
	}
	return out, nil
}

// UserPreset — user_id → preset (from ListUserPrincipals).
type UserPreset struct {
	UserID int64
	Preset sql.NullString
}

// UserPermissionRef — a per-user override reference (from ListAllUserPermissions).
type UserPermissionRef struct {
	UserID   int64
	Resource string
	Action   string
	Scope    string
	Granted  bool
}

func toInt8(v *int64) pgtype.Int8 {
	if v == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *v, Valid: true}
}

func fromInt8(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	out := v.Int64
	return &out
}
