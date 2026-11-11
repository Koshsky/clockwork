package service

import (
	"context"
	"encoding/json"
	"log/slog"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/dto"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/authz/repository"
	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// policyRepository is the repository seam of the RBAC administration service
// and the policy store; implemented by *repository.RuleRepository and by the
// test fakes. Keeping the seam here lets the service be unit-tested without a
// database (the concrete repository is injected unchanged by the constructors).
type policyRepository interface {
	ListActivePresets(ctx context.Context) ([]sqlc.ListActivePresetsRow, error)
	ListActiveRules(ctx context.Context) ([]sqlc.ListActivePresetRulesRow, error)
	UpsertRule(
		ctx context.Context,
		preset, resource, action, scope string,
		updatedBy *int64,
	) (sqlc.UpsertPresetRuleRow, error)
	DeleteRule(ctx context.Context, id int64) error
	ListActiveRoutePolicies(ctx context.Context) ([]domain.RoutePolicy, error)
	UpsertRoutePolicy(ctx context.Context, p domain.RoutePolicy) (domain.RoutePolicy, error)
	DeleteRoutePolicy(ctx context.Context, name string) error
	ResetPolicies(
		ctx context.Context,
		rules []sqlc.UpsertPresetRuleParams,
		policies []sqlc.UpsertRoutePolicyParams,
	) error
	UpsertPreset(ctx context.Context, tag, name, description string) (sqlc.UpsertPresetRow, error)
	UpdatePreset(ctx context.Context, tag, newTag, name, description string) (sqlc.RenamePresetRow, error)
	DeletePreset(ctx context.Context, tag string) error
	ListUserPermissions(ctx context.Context, userID int64) ([]sqlc.ListUserPermissionsRow, error)
	ReplaceUserPermissions(ctx context.Context, userID int64, perms []sqlc.InsertUserPermissionParams) error
	FindUserPreset(ctx context.Context, userID int64) (string, bool, error)
	ListUserPrincipals(ctx context.Context) ([]repository.UserPreset, error)
	ListAllUserPermissions(ctx context.Context) ([]repository.UserPermissionRef, error)
}

// Service — RBAC policy administration (validation + DB writes +
// immediate application through the PolicyStore).
type Service struct {
	logger *slog.Logger
	repo   policyRepository
	store  *PolicyStore
}

// NewRBACService builds the RBAC administration service.
func NewRBACService(logger *slog.Logger, repo *repository.RuleRepository, store *PolicyStore) *Service {
	return &Service{logger: logger.With("component", "rbacpolicy_service"), repo: repo, store: store}
}

// ListPresets returns the preset catalog.
func (s *Service) ListPresets(ctx context.Context) ([]sqlc.ListActivePresetsRow, error) {
	return s.repo.ListActivePresets(ctx)
}

// ListRules returns the active matrix rows.
func (s *Service) ListRules(ctx context.Context) ([]sqlc.ListActivePresetRulesRow, error) {
	return s.repo.ListActiveRules(ctx)
}

// UpsertRule validates and writes a matrix row, then applies the
// changes immediately.
func (s *Service) UpsertRule(ctx context.Context, in dto.PresetRuleInput, updatedBy int64) error {
	if in.Preset == "" {
		return errors.BadRequest("пресет обязателен")
	}
	presets, err := s.repo.ListActivePresets(ctx)
	if err != nil {
		return err
	}
	if !presetExists(presets, in.Preset) {
		return errors.BadRequest("неизвестный пресет " + in.Preset)
	}
	res, ok := engine.ParseResource(in.Resource)
	if !ok {
		return errors.BadRequest("неизвестный ресурс " + in.Resource)
	}
	if action, okAction := engine.ParseAction(in.Action); !okAction || !engine.ActionApplicable(res, action) {
		return errors.BadRequest("неизвестное действие " + in.Action)
	}
	scope, ok := engine.ParseScope(in.Scope)
	if !ok || scope == engine.ScopeNone {
		return errors.BadRequest("недопустимая зона " + in.Scope + " (all|own|parent|ancestor)")
	}
	if !engine.ScopeApplicable(res, scope) {
		return errors.BadRequest("зона " + in.Scope + " неприменима к ресурсу " + in.Resource)
	}

	if _, upsertErr := s.repo.UpsertRule(
		ctx,
		in.Preset,
		in.Resource,
		in.Action,
		in.Scope,
		&updatedBy,
	); upsertErr != nil {
		return upsertErr
	}
	return s.apply(ctx)
}

// DeleteRule removes a matrix row (archived by the DB trigger). Rows of the
// admin preset are protected: admin rights are the code bypass, and its
// matrix rows must not be removable through the admin API.
func (s *Service) DeleteRule(ctx context.Context, id int64) error {
	rules, err := s.repo.ListActiveRules(ctx)
	if err != nil {
		return err
	}
	if preset, ok := findRulePreset(rules, id); ok && preset == userdomain.PresetAdmin {
		return builtinPresetErr(preset)
	}
	if err = s.repo.DeleteRule(ctx, id); err != nil {
		return err
	}
	return s.apply(ctx)
}

// ListRoutePolicies returns the active route policy definitions.
func (s *Service) ListRoutePolicies(ctx context.Context) ([]domain.RoutePolicy, error) {
	return s.repo.ListActiveRoutePolicies(ctx)
}

// UpsertRoutePolicy validates (kind + parameters against the schema) and writes
// the route policy.
func (s *Service) UpsertRoutePolicy(ctx context.Context, in dto.RoutePolicyInput, updatedBy int64) error {
	if err := engine.ValidateSpec(engine.RouteSpec{Name: in.Name, Kind: in.Kind, Params: in.Params}); err != nil {
		return errors.BadRequest(err.Error())
	}
	active := true
	if in.Active != nil {
		active = *in.Active
	}
	if _, err := s.repo.UpsertRoutePolicy(ctx, domain.RoutePolicy{
		Name: in.Name, Kind: in.Kind, Params: in.Params, Active: active,
		UpdatedBy: &updatedBy,
	}); err != nil {
		return err
	}
	return s.apply(ctx)
}

// DeleteRoutePolicy removes a route policy by name (archived).
func (s *Service) DeleteRoutePolicy(ctx context.Context, name string) error {
	if err := s.repo.DeleteRoutePolicy(ctx, name); err != nil {
		return err
	}
	return s.apply(ctx)
}

// Reset restores rules and route policies to the built-in defaults (an
// escape hatch after erroneous edits). The whole reset runs inside a single
// transaction (the repository joins the ambient one when the idempotency
// middleware opened it): on any error the DB is unchanged — rolled back, never
// half-reseeded — and the engine keeps its current snapshot; only after a
// successful commit is the new state applied to the in-memory engine.
func (s *Service) Reset(ctx context.Context, updatedBy int64) error {
	defaults := engine.DefaultMatrixRules()
	rules := make([]sqlc.UpsertPresetRuleParams, 0, len(defaults))
	for _, r := range defaults {
		rules = append(rules, sqlc.UpsertPresetRuleParams{
			Preset:    r.Role,
			Resource:  engine.ResourceName(r.Res),
			Action:    engine.ActionName(r.Act),
			Scope:     engine.ScopeName(r.Scope),
			UpdatedBy: pgtype.Int8{Int64: updatedBy, Valid: true},
		})
	}
	specs := engine.DefaultRouteSpecs()
	policies := make([]sqlc.UpsertRoutePolicyParams, 0, len(specs))
	for _, spec := range specs {
		params, err := json.Marshal(spec.Params)
		if err != nil {
			return err
		}
		policies = append(policies, sqlc.UpsertRoutePolicyParams{
			Name:      spec.Name,
			Kind:      spec.Kind,
			Params:    params,
			Active:    true,
			UpdatedBy: pgtype.Int8{Int64: updatedBy, Valid: true},
		})
	}
	if err := s.repo.ResetPolicies(ctx, rules, policies); err != nil {
		return err
	}
	return s.apply(ctx)
}

// EffectiveMatrix returns the COMPLETE effective matrix for the API: every
// catalog preset (plus admin) × every resource × every action, with the
// resolved scope expression and engine.ScopeNoneCode where a preset holds no
// right. The UI renders this payload as is, so a missing cell would silently
// hide a right and a resource added to the engine must show up without a
// frontend change.
func (s *Service) EffectiveMatrix(ctx context.Context) ([]dto.MatrixCell, error) {
	_ = ctx // matrix and presets are read from memory/DB without extra queries
	presets, err := s.repo.ListActivePresets(ctx)
	if err != nil {
		return nil, err
	}
	matrix := engine.CurrentMatrix()
	// Preset keys are TAGS (the codes stored in users.preset and
	// rbac_preset_rules.preset) — never the display names from the catalog.
	// The catalog carries the admin row too; its cells are added explicitly
	// below, so it must not be appended twice.
	tags := make([]string, 0, len(presets)+1)
	tags = append(tags, userdomain.PresetAdmin)
	for _, p := range presets {
		if p.Tag == userdomain.PresetAdmin {
			continue
		}
		tags = append(tags, p.Tag)
	}
	return buildMatrixCells(tags, matrix), nil
}

// buildMatrixCells renders the complete grid for the given preset tags.
func buildMatrixCells(tags []string, matrix engine.Matrix) []dto.MatrixCell {
	cells := make([]dto.MatrixCell, 0, len(tags)*resourceCount*actionCount)
	for _, preset := range tags {
		for res := rbac.ResourceProject; res <= rbac.ResourceAutoCreate; res++ {
			for act := engine.ActionView; act <= engine.ActionPrioritize; act++ {
				if !engine.ActionApplicable(res, act) {
					continue
				}
				cells = append(cells, dto.MatrixCell{
					Preset:   preset,
					Resource: engine.ResourceName(res),
					Action:   engine.ActionName(act),
					Scope:    scopeCode(matrix.ScopeFor(preset, res, act)),
				})
			}
		}
	}
	return cells
}

// resourceCount and actionCount size the matrix payload (the engine enums are
// contiguous: rbac.ResourceProject..ResourceAutoCreate, ActionView..ActionPrioritize).
const (
	resourceCount = int(rbac.ResourceAutoCreate) + 1
	actionCount   = int(engine.ActionDelete) + 1
)

// scopeCode renders a resolved scope for the API: the canonical expression, or
// ScopeNoneCode for "no right" — an empty string would read as a granted cell
// in the UI (it coalesces only null/undefined to "none").
func scopeCode(scope string) string {
	if scope == engine.ScopeNone {
		return engine.ScopeNoneCode
	}
	return engine.ScopeName(scope)
}

// Kinds returns the catalog of route policy kinds.
func (s *Service) Kinds() []engine.KindInfo {
	return engine.Kinds()
}

// Explain answers "why allow/deny" for debugging DB-backed rules.
func (s *Service) Explain(_ context.Context, in dto.ExplainInput) (dto.ExplainResult, error) {
	res, ok := engine.ParseResource(in.Resource)
	if !ok {
		return dto.ExplainResult{}, errors.BadRequest("неизвестный ресурс " + in.Resource)
	}
	act, ok := engine.ParseAction(in.Action)
	if !ok {
		return dto.ExplainResult{}, errors.BadRequest("неизвестное действие " + in.Action)
	}
	scope := engine.CurrentMatrix().ScopeFor(in.Preset, res, act)
	allowed := engine.Authorize(in.Preset, res, act, rbac.Owners{
		ProjectOwner: in.ProjectOwner,
		ProcessOwner: in.ProcessOwner,
		Owner:        in.Owner,
	}, in.UserID)
	return dto.ExplainResult{Scope: engine.ScopeName(scope), Allowed: allowed}, nil
}

// apply applies the current DB state to the engine.
func (s *Service) apply(ctx context.Context) error {
	if err := s.store.Reload(ctx); err != nil {
		s.logger.ErrorContext(
			ctx,
			"rbac: применение изменений не удалось (продолжаю на последнем снапшоте)",
			"error",
			err,
		)
	}
	return nil
}

func presetExists(presets []sqlc.ListActivePresetsRow, tag string) bool {
	for _, p := range presets {
		if p.Tag == tag {
			return true
		}
	}
	return false
}

// MyPermissions returns the caller's principal permissions (all allowed
// actions with an effective scope != none; admin — everything). Used by the
// frontend to display capabilities by permissions rather than by presets. The
// source is the published Casbin snapshot (RBAC roles + ACL grants/revokes +
// admin bypass) — exactly the rights the engine applies to requests; the
// data-level matrix (CurrentMatrix) is only for the admin editor views.
func (s *Service) MyPermissions(_ context.Context, user userctx.UserContext) []dto.Permission {
	out := []dto.Permission{}
	for res := rbac.ResourceProject; res <= rbac.ResourceAutoCreate; res++ {
		for act := engine.ActionView; act <= engine.ActionPrioritize; act++ {
			if !engine.ActionApplicable(res, act) {
				continue
			}
			scope := engine.ScopeForUser(user, res, act)
			inherited := act == engine.ActionView && engine.HasViewAncestor(user, res)
			if scope == engine.ScopeNone && inherited {
				scope = "inherited"
			}
			if scope == engine.ScopeNone {
				continue
			}
			out = append(out, dto.Permission{
				Inherited: inherited,
				Resource:  engine.ResourceName(res),
				Action:    engine.ActionName(act),
				Scope:     engine.ScopeName(scope),
			})
		}
	}
	return out
}

// ListUserPermissions returns the editor view of a user's permissions: the
// assigned preset, the current overrides, the preset baseline (without
// overrides) and the resulting effective matrix.
func (s *Service) ListUserPermissions(
	ctx context.Context,
	userID int64,
) (dto.UserPermissionsView, error) {
	presetCode, presetSet, err := s.repo.FindUserPreset(ctx, userID)
	if err != nil {
		return dto.UserPermissionsView{}, err
	}
	rows, err := s.repo.ListUserPermissions(ctx, userID)
	if err != nil {
		return dto.UserPermissionsView{}, err
	}
	var preset *string
	if presetSet {
		preset = &presetCode
	}
	overrides := make([]dto.PermissionOverride, 0, len(rows))
	for _, p := range rows {
		overrides = append(overrides, dto.PermissionOverride{
			Resource: p.Resource,
			Action:   p.Action,
			Scope:    p.Scope,
			Granted:  p.Granted,
		})
	}
	admin := presetSet && presetCode == userdomain.PresetAdmin
	// Preset baseline: the assigned preset without individual overrides.
	base := userctx.UserContext{
		ID:     userID,
		Admin:  admin,
		Preset: presetNameRef(preset),
	}
	// Effective matrix: the caller's principal applied to every resource/action.
	principal := base
	principal.Rules = toRules(overrides)
	return dto.UserPermissionsView{
		UserID:      userID,
		Preset:      preset,
		Admin:       admin,
		Overrides:   overrides,
		PresetScope: s.MyPermissions(ctx, base),
		Effective:   s.MyPermissions(ctx, principal),
	}, nil
}

// ReplaceUserPermissions validates and replaces the user's override set
// (full replacement), then applies the change immediately.
func (s *Service) ReplaceUserPermissions(
	ctx context.Context,
	userID int64,
	in dto.UserPermissionsInput,
	updatedBy int64,
) error {
	rows := make([]sqlc.InsertUserPermissionParams, 0, len(in.Overrides))
	seen := map[string]bool{}
	for _, o := range in.Overrides {
		res, ok := engine.ParseResource(o.Resource)
		if !ok {
			return errors.BadRequest("неизвестный ресурс " + o.Resource)
		}
		if action, okAction := engine.ParseAction(o.Action); !okAction || !engine.ActionApplicable(res, action) {
			return errors.BadRequest("неизвестное действие " + o.Action)
		}
		key := o.Resource + "/" + o.Action
		if seen[key] {
			return errors.BadRequest("дублируется право " + key)
		}
		seen[key] = true
		scope := "all"
		if o.Granted {
			parsed, okScope := engine.ParseScope(o.Scope)
			if !okScope || parsed == engine.ScopeNone {
				return errors.BadRequest("недопустимая зона " + o.Scope + " (all|own|parent|ancestor)")
			}
			if !engine.ScopeApplicable(res, parsed) {
				return errors.BadRequest("зона " + o.Scope + " неприменима к ресурсу " + o.Resource)
			}
			scope = o.Scope
		}
		rows = append(rows, sqlc.InsertUserPermissionParams{
			UserID:    userID,
			Resource:  o.Resource,
			Action:    o.Action,
			Scope:     scope,
			Granted:   o.Granted,
			UpdatedBy: pgtype.Int8{Int64: updatedBy, Valid: true},
		})
	}
	if err := s.repo.ReplaceUserPermissions(ctx, userID, rows); err != nil {
		return err
	}
	return s.apply(ctx)
}

// toRules converts overrides into the engine's user-rule model.
func toRules(overrides []dto.PermissionOverride) []userctx.PermissionRule {
	out := make([]userctx.PermissionRule, 0, len(overrides))
	for _, o := range overrides {
		out = append(out, userctx.PermissionRule{
			Resource: o.Resource,
			Action:   o.Action,
			Scope:    o.Scope,
			Granted:  o.Granted,
		})
	}
	return out
}

// presetNameRef unwraps a preset pointer ("" — none).
func presetNameRef(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// maxPresetNameLen — maximum preset name length.
const (
	maxPresetTagLen  = 32
	maxPresetNameLen = 64
)

// CreatePreset creates a preset (or updates an existing one) and applies it.
// The seeded built-in presets (V9 catalog) are immutable: the upsert must
// not clobber them (in particular, never overwrite the admin entry).
func (s *Service) CreatePreset(ctx context.Context, in dto.PresetUpsertInput) (sqlc.UpsertPresetRow, error) {
	tag := strings.TrimSpace(in.Tag)
	name := strings.TrimSpace(in.Name)
	if err := validatePresetTag(tag); err != nil {
		return sqlc.UpsertPresetRow{}, err
	}
	if err := validatePresetDisplayName(name); err != nil {
		return sqlc.UpsertPresetRow{}, err
	}
	if isBuiltinPreset(tag) {
		return sqlc.UpsertPresetRow{}, builtinPresetErr(tag)
	}
	preset, err := s.repo.UpsertPreset(ctx, tag, name, strings.TrimSpace(in.Description))
	if err != nil {
		return sqlc.UpsertPresetRow{}, err
	}
	_ = s.apply(ctx)
	return preset, nil
}

// UpdatePreset updates a preset: the display name and description always, plus
// an optional tag rename (Tag in the input). The seeded built-in presets
// (V9 catalog) are immutable via the admin API.
func (s *Service) UpdatePreset(
	ctx context.Context,
	tag string,
	in dto.PresetUpdateInput,
) (sqlc.RenamePresetRow, error) {
	if isBuiltinPreset(tag) {
		return sqlc.RenamePresetRow{}, builtinPresetErr(tag)
	}
	name := strings.TrimSpace(in.Name)
	if err := validatePresetDisplayName(name); err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	newTag, err := resolvePresetRename(ctx, s.repo, tag, in.Tag)
	if err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	preset, err := s.repo.UpdatePreset(ctx, tag, newTag, name, strings.TrimSpace(in.Description))
	if err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	if err = s.apply(ctx); err != nil {
		return sqlc.RenamePresetRow{}, err
	}
	return preset, nil
}

// DeletePreset deletes a preset, its rules and clears the preset ref on
// assigned users (they keep the account but lose the preset's base rights;
// individual overrides survive). The seeded built-in presets (V9: admin, dp,
// rp, vp, worker) are protected: deleting admin would clear users.preset for
// every administrator and permanently lock them out of /rbac/*.
func (s *Service) DeletePreset(ctx context.Context, tag string) error {
	if isBuiltinPreset(tag) {
		return builtinPresetErr(tag)
	}
	if err := s.repo.DeletePreset(ctx, tag); err != nil {
		return err
	}
	return s.apply(ctx)
}

// validPresetTag — allowed characters of a preset tag (system access code):
// letters of any script (latin, cyrillic), digits, "-" and "_".
func validPresetTag(tag string) bool {
	return regexp.MustCompile(`^[\p{L}\p{N}_-]+$`).MatchString(tag)
}

// validatePresetTag validates a preset tag: non-empty, no longer than 32, a code.
func validatePresetTag(tag string) error {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return errors.BadRequest("тэг пресета не может быть пустым")
	}
	if len(tag) > maxPresetTagLen {
		return errors.BadRequest("тэг пресета не длиннее 32 символов")
	}
	if !validPresetTag(tag) {
		return errors.BadRequest("тэг пресета: буквы (латиница/кириллица), цифры, «-» и «_»")
	}
	return nil
}

// validatePresetDisplayName validates the human-readable preset name: non-empty,
// no longer than 64 characters.
func validatePresetDisplayName(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return errors.BadRequest("имя пресета не может быть пустым")
	}
	if len(name) > maxPresetNameLen {
		return errors.BadRequest("имя пресета не длиннее 64 символов")
	}
	return nil
}

// builtinPresetErr describes an operation on a seeded built-in preset.
func builtinPresetErr(name string) error {
	return errors.BadRequest("встроенный пресет " + name + " нельзя изменять или удалять")
}

// isBuiltinPreset reports whether the preset is one of the seeded built-ins
// (the V9 catalog: admin, dp, rp, vp, worker) — immutable via the RBAC
// admin API, as removing them (in particular admin) would lock out admins.
func isBuiltinPreset(name string) bool {
	// The admin entry is a code invariant (deleting it would clear
	// users.preset for every administrator and lock them out of /rbac/*);
	// every other preset — including the seeded dp/rp/vp/worker — is a
	// regular catalog entry and can be deleted or renamed by an admin.
	return name == userdomain.PresetAdmin
}

// findRulePreset returns the preset of the matrix row with the given id.
func findRulePreset(rules []sqlc.ListActivePresetRulesRow, id int64) (string, bool) {
	for _, r := range rules {
		if r.ID == id {
			return r.Preset, true
		}
	}
	return "", false
}

// resolvePresetRename validates an optional tag rename target of a preset
// (pattern, built-in and catalog collisions); returns the effective tag.
func resolvePresetRename(ctx context.Context, repo policyRepository, tag string, rename *string) (string, error) {
	if rename == nil {
		return tag, nil
	}
	newTag := strings.TrimSpace(*rename)
	if err := validatePresetTag(newTag); err != nil {
		return "", err
	}
	if isBuiltinPreset(newTag) {
		return "", errors.BadRequest("встроенный пресет " + newTag + " нельзя занять этим тэгом")
	}
	if newTag == tag {
		return newTag, nil
	}
	presets, err := repo.ListActivePresets(ctx)
	if err != nil {
		return "", err
	}
	for _, p := range presets {
		if p.Tag == newTag {
			return "", errors.BadRequest("пресет с тэгом " + newTag + " уже существует")
		}
	}
	return newTag, nil
}
