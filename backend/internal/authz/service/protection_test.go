//nolint:testpackage // service tests drive the unexported repository seam (policyRepository)
package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/dto"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/authz/repository"
	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/pkg/errors"
)

// stubPolicyRepo is an in-memory policyRepository. It records every call in
// callLog and implements the transactional contract of ResetPolicies on its
// persisted state: the deletes and the upserts are applied step by step, and a
// failure on the failOnInsert-th insert rolls the whole state back — nothing
// residual stays.
type stubPolicyRepo struct {
	activeRules   []sqlc.ListActivePresetRulesRow
	routePolicies []domain.RoutePolicy
	principals    []repository.UserPreset
	permissions   []repository.UserPermissionRef

	persistedRules    []sqlc.UpsertPresetRuleParams
	persistedPolicies []sqlc.UpsertRoutePolicyParams

	failOnInsert    int
	callLog         []string
	resetCalls      int
	deletedRuleIDs  []int64
	upsertedPresets []string
	deletedPresets  []string
	presetCatalog   []sqlc.ListActivePresetsRow
}

func (s *stubPolicyRepo) logCall(call string) {
	s.callLog = append(s.callLog, call)
}

func (s *stubPolicyRepo) ListActivePresets(_ context.Context) ([]sqlc.ListActivePresetsRow, error) {
	s.logCall("ListActivePresets")
	return s.presetCatalog, nil
}

func (s *stubPolicyRepo) ListActiveRules(_ context.Context) ([]sqlc.ListActivePresetRulesRow, error) {
	s.logCall("ListActiveRules")
	return s.activeRules, nil
}

func (s *stubPolicyRepo) UpsertRule(
	_ context.Context,
	_, _, _, _ string,
	_ *int64,
) (sqlc.UpsertPresetRuleRow, error) {
	s.logCall("UpsertRule")
	return sqlc.UpsertPresetRuleRow{}, nil
}

func (s *stubPolicyRepo) DeleteRule(_ context.Context, id int64) error {
	s.logCall("DeleteRule")
	s.deletedRuleIDs = append(s.deletedRuleIDs, id)
	return nil
}

func (s *stubPolicyRepo) ListActiveRoutePolicies(_ context.Context) ([]domain.RoutePolicy, error) {
	s.logCall("ListActiveRoutePolicies")
	return s.routePolicies, nil
}

func (s *stubPolicyRepo) UpsertRoutePolicy(_ context.Context, _ domain.RoutePolicy) (domain.RoutePolicy, error) {
	s.logCall("UpsertRoutePolicy")
	return domain.RoutePolicy{}, nil
}

func (s *stubPolicyRepo) DeleteRoutePolicy(_ context.Context, _ string) error {
	s.logCall("DeleteRoutePolicy")
	return nil
}

// ResetPolicies applies the reset to the persisted state and rolls the whole
// state back when an insert fails, mirroring the repository transaction.
func (s *stubPolicyRepo) ResetPolicies(
	_ context.Context,
	rules []sqlc.UpsertPresetRuleParams,
	policies []sqlc.UpsertRoutePolicyParams,
) error {
	s.resetCalls++
	s.logCall("ResetPolicies")
	prevRules := slices.Clone(s.persistedRules)
	prevPolicies := slices.Clone(s.persistedPolicies)
	s.persistedRules = nil
	s.persistedPolicies = nil
	if err := s.applyReseed(rules, policies); err != nil {
		s.persistedRules = prevRules
		s.persistedPolicies = prevPolicies
		return err
	}
	return nil
}

// applyReseed runs the delete-then-insert steps of the reset and fails on the
// failOnInsert-th insert (1-based across rules and policies).
func (s *stubPolicyRepo) applyReseed(
	rules []sqlc.UpsertPresetRuleParams,
	policies []sqlc.UpsertRoutePolicyParams,
) error {
	insert := 0
	for _, r := range rules {
		insert++
		if s.failOnInsert == insert {
			return fmt.Errorf("reset failed on rule insert %d", insert)
		}
		s.persistedRules = append(s.persistedRules, r)
	}
	for _, p := range policies {
		insert++
		if s.failOnInsert == insert {
			return fmt.Errorf("reset failed on policy insert %d", insert)
		}
		s.persistedPolicies = append(s.persistedPolicies, p)
	}
	return nil
}

func (s *stubPolicyRepo) UpsertPreset(_ context.Context, tag, _, _ string) (sqlc.UpsertPresetRow, error) {
	s.logCall("UpsertPreset")
	s.upsertedPresets = append(s.upsertedPresets, tag)
	return sqlc.UpsertPresetRow{Tag: tag}, nil
}

func (s *stubPolicyRepo) UpdatePreset(
	_ context.Context,
	_, newTag, _, _ string,
) (sqlc.RenamePresetRow, error) {
	s.logCall("UpdatePreset")
	return sqlc.RenamePresetRow{Tag: newTag}, nil
}

func (s *stubPolicyRepo) DeletePreset(_ context.Context, tag string) error {
	s.logCall("DeletePreset")
	s.deletedPresets = append(s.deletedPresets, tag)
	return nil
}

func (s *stubPolicyRepo) ListUserPermissions(_ context.Context, _ int64) ([]sqlc.ListUserPermissionsRow, error) {
	s.logCall("ListUserPermissions")
	return nil, nil
}

func (s *stubPolicyRepo) ReplaceUserPermissions(
	_ context.Context,
	_ int64,
	_ []sqlc.InsertUserPermissionParams,
) error {
	s.logCall("ReplaceUserPermissions")
	return nil
}

func (s *stubPolicyRepo) FindUserPreset(_ context.Context, _ int64) (string, bool, error) {
	s.logCall("FindUserPreset")
	return "", false, nil
}

func (s *stubPolicyRepo) ListUserPrincipals(_ context.Context) ([]repository.UserPreset, error) {
	s.logCall("ListUserPrincipals")
	return s.principals, nil
}

func (s *stubPolicyRepo) ListAllUserPermissions(_ context.Context) ([]repository.UserPermissionRef, error) {
	s.logCall("ListAllUserPermissions")
	return s.permissions, nil
}

// newAuthzTestService builds an RBAC Service over the stub repository and an
// in-memory PolicyStore, so every repository call and the engine apply that
// the service triggers are observable through the stub.
func newAuthzTestService(repo *stubPolicyRepo) *Service {
	store := &PolicyStore{
		logger: slog.New(slog.DiscardHandler),
		repo:   repo,
		mw:     &rbac.Middleware{},
	}
	return &Service{
		logger: slog.New(slog.DiscardHandler),
		repo:   repo,
		store:  store,
	}
}

// defaultRoutePolicies returns the default route policy set as repository
// rows (a valid input for PolicyStore.Reload → engine.BuildPolicies).
func defaultRoutePolicies() []domain.RoutePolicy {
	specs := engine.DefaultRouteSpecs()
	out := make([]domain.RoutePolicy, 0, len(specs))
	for _, s := range specs {
		out = append(out, domain.RoutePolicy{Name: s.Name, Kind: s.Kind, Params: s.Params, Active: true})
	}
	return out
}

// defaultRuleParams replicates the service's Reset transformation of the
// default matrix into sqlc.UpsertPresetRuleParams.
func defaultRuleParams(updatedBy int64) []sqlc.UpsertPresetRuleParams {
	defaults := engine.DefaultMatrixRules()
	out := make([]sqlc.UpsertPresetRuleParams, 0, len(defaults))
	for _, r := range defaults {
		out = append(out, sqlc.UpsertPresetRuleParams{
			Preset:    r.Role,
			Resource:  engine.ResourceName(r.Res),
			Action:    engine.ActionName(r.Act),
			Scope:     engine.ScopeName(r.Scope),
			UpdatedBy: pgtype.Int8{Int64: updatedBy, Valid: true},
		})
	}
	return out
}

// defaultPolicyParams replicates the service's Reset transformation of the
// default route specs into sqlc.UpsertRoutePolicyParams.
func defaultPolicyParams(updatedBy int64) []sqlc.UpsertRoutePolicyParams {
	specs := engine.DefaultRouteSpecs()
	out := make([]sqlc.UpsertRoutePolicyParams, 0, len(specs))
	for _, spec := range specs {
		params, err := json.Marshal(spec.Params)
		if err != nil {
			panic(err)
		}
		out = append(out, sqlc.UpsertRoutePolicyParams{
			Name:      spec.Name,
			Kind:      spec.Kind,
			Params:    params,
			Active:    true,
			UpdatedBy: pgtype.Int8{Int64: updatedBy, Valid: true},
		})
	}
	return out
}

// sameRuleSet compares two rule-param sets regardless of the order the engine
// produces them in (DefaultMatrixRules iterates maps).
func sameRuleSet(a, b []sqlc.UpsertPresetRuleParams) bool {
	if len(a) != len(b) {
		return false
	}
	byKey := make(map[string]string, len(a))
	for _, r := range a {
		byKey[r.Preset+"/"+r.Resource+"/"+r.Action] = r.Scope
	}
	for _, r := range b {
		key := r.Preset + "/" + r.Resource + "/" + r.Action
		if byKey[key] != r.Scope {
			return false
		}
	}
	return true
}

// samePolicySet compares two route-policy param sets regardless of order.
func samePolicySet(a, b []sqlc.UpsertRoutePolicyParams) bool {
	if len(a) != len(b) {
		return false
	}
	byName := make(map[string]string, len(a))
	for _, p := range a {
		byName[p.Name] = string(p.Params)
	}
	for _, p := range b {
		if byName[p.Name] != string(p.Params) {
			return false
		}
	}
	return true
}

// equalPolicies compares two route-policy param slices element-wise (the
// params are [json.RawMessage], so the slices are not comparable).
func equalPolicies(a, b []sqlc.UpsertRoutePolicyParams) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		x, y := a[i], b[i]
		if x.Name != y.Name || x.Kind != y.Kind || x.Active != y.Active ||
			string(x.Params) != string(y.Params) || x.UpdatedBy != y.UpdatedBy {
			return false
		}
	}
	return true
}

// reloadCalls is the repository read sequence of PolicyStore.Reload.
func reloadCalls() []string {
	return []string{
		"ListActiveRules",
		"ListActiveRoutePolicies",
		"ListUserPrincipals",
		"ListAllUserPermissions",
		"ListUserPrincipals",
		"ListAllUserPermissions",
	}
}

// TestDeletePresetRefusesBuiltins checks that every seeded built-in preset is
// refused by DeletePreset with the builtin error and without touching the
// repository at all.
func TestDeletePresetRefusesBuiltins(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{}
	svc := newAuthzTestService(repo)

	for _, name := range []string{userdomain.PresetAdmin} {
		err := svc.DeletePreset(context.Background(), name)
		if err == nil {
			t.Errorf("DeletePreset(%q) succeeded on a built-in preset", name)
			continue
		}
		if err.Error() != builtinPresetErr(name).Error() {
			t.Errorf("DeletePreset(%q) error = %q, want %q", name, err, builtinPresetErr(name))
		}
		if errors.StatusCode(err) != http.StatusBadRequest {
			t.Errorf("DeletePreset(%q) status = %d, want 400", name, errors.StatusCode(err))
		}
	}
	if len(repo.callLog) != 0 {
		t.Errorf("built-in preset deletes touched the repository: %v", repo.callLog)
	}
	if len(repo.deletedPresets) != 0 {
		t.Errorf("built-in preset deletes persisted: %v", repo.deletedPresets)
	}
}

// TestUpdatePresetRefusesBuiltins checks that UpdatePreset refuses every
// built-in preset before any repository call.
func TestUpdatePresetRefusesBuiltins(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{}
	svc := newAuthzTestService(repo)

	for _, name := range []string{userdomain.PresetAdmin} {
		_, err := svc.UpdatePreset(context.Background(), name, dto.PresetUpdateInput{Name: "x", Description: "x"})
		if err == nil {
			t.Errorf("UpdatePreset(%q) succeeded on a built-in preset", name)
			continue
		}
		if err.Error() != builtinPresetErr(name).Error() {
			t.Errorf("UpdatePreset(%q) error = %q, want %q", name, err, builtinPresetErr(name))
		}
		if errors.StatusCode(err) != http.StatusBadRequest {
			t.Errorf("UpdatePreset(%q) status = %d, want 400", name, errors.StatusCode(err))
		}
	}
	if len(repo.callLog) != 0 {
		t.Errorf("built-in preset updates touched the repository: %v", repo.callLog)
	}
}

// TestUpdatePresetRename checks the rename path: a fresh valid name goes to
// the repository, a name of a built-in preset is refused, and a name occupied
// by another catalog entry is refused before any repository call.
func TestUpdatePresetRename(t *testing.T) {
	t.Parallel()
	t.Run("rename to a valid tag", func(t *testing.T) {
		t.Parallel()
		repo := &stubPolicyRepo{}
		svc := newAuthzTestService(repo)
		newTag := "auditor"
		_, err := svc.UpdatePreset(
			context.Background(),
			"old",
			dto.PresetUpdateInput{Tag: &newTag, Name: "x", Description: "x"},
		)
		if err != nil {
			t.Fatalf("UpdatePreset(rename) error = %v", err)
		}
		if !slices.Contains(repo.callLog, "UpdatePreset") {
			t.Errorf("rename did not reach the repository: %v", repo.callLog)
		}
	})
	t.Run("rename onto a built-in tag is refused", func(t *testing.T) {
		t.Parallel()
		repo := &stubPolicyRepo{}
		svc := newAuthzTestService(repo)
		newTag := "admin"
		_, err := svc.UpdatePreset(context.Background(), "old", dto.PresetUpdateInput{Tag: &newTag, Name: "x"})
		if err == nil {
			t.Fatal("UpdatePreset(rename to admin) succeeded")
		}
		if len(repo.callLog) != 0 {
			t.Errorf("refused rename touched the repository: %v", repo.callLog)
		}
	})
	t.Run("rename onto an occupied tag is refused", func(t *testing.T) {
		t.Parallel()
		repo := &stubPolicyRepo{}
		repo.presetCatalog = []sqlc.ListActivePresetsRow{{Tag: "taken"}}
		svc := newAuthzTestService(repo)
		newTag := "taken"
		_, err := svc.UpdatePreset(context.Background(), "old", dto.PresetUpdateInput{Tag: &newTag, Name: "x"})
		if err == nil {
			t.Fatal("UpdatePreset(rename to taken) succeeded")
		}
		// Only the catalog lookup happened; no write reached the repository.
		if slices.Contains(repo.callLog, "UpdatePreset") {
			t.Errorf("refused rename persisted: %v", repo.callLog)
		}
	})
}

// TestCreatePresetRefusesBuiltins checks that CreatePreset refuses to create
// or overwrite a seeded built-in preset (in particular admin).
func TestCreatePresetRefusesBuiltins(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{}
	svc := newAuthzTestService(repo)

	for _, name := range []string{userdomain.PresetAdmin} {
		_, err := svc.CreatePreset(context.Background(), dto.PresetUpsertInput{Tag: name, Name: "x"})
		if err == nil {
			t.Errorf("CreatePreset(%q) succeeded on a built-in preset", name)
			continue
		}
		if err.Error() != builtinPresetErr(name).Error() {
			t.Errorf("CreatePreset(%q) error = %q, want %q", name, err, builtinPresetErr(name))
		}
		if errors.StatusCode(err) != http.StatusBadRequest {
			t.Errorf("CreatePreset(%q) status = %d, want 400", name, errors.StatusCode(err))
		}
	}
	if len(repo.callLog) != 0 {
		t.Errorf("built-in preset upserts touched the repository: %v", repo.callLog)
	}
	if len(repo.upsertedPresets) != 0 {
		t.Errorf("built-in preset upserts persisted: %v", repo.upsertedPresets)
	}
}

// TestDeleteRuleRefusesAdminRow checks that a matrix row of the admin preset
// cannot be deleted: the row is resolved first and the delete is refused
// before any repository mutation or engine apply.
func TestDeleteRuleRefusesAdminRow(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{
		activeRules: []sqlc.ListActivePresetRulesRow{
			{ID: 41, Preset: userdomain.PresetAdmin, Resource: "rbac_config", Action: "view", Scope: "all"},
		},
	}
	svc := newAuthzTestService(repo)

	err := svc.DeleteRule(context.Background(), 41)
	if err == nil {
		t.Fatal("DeleteRule() removed an admin matrix row")
	}
	if err.Error() != builtinPresetErr(userdomain.PresetAdmin).Error() {
		t.Errorf("DeleteRule() error = %q, want %q", err, builtinPresetErr(userdomain.PresetAdmin))
	}
	if !slices.Equal(repo.callLog, []string{"ListActiveRules"}) {
		t.Errorf("admin-row delete issued calls %v, want only the rule lookup", repo.callLog)
	}
	if len(repo.deletedRuleIDs) != 0 {
		t.Errorf("admin row was persisted as deleted: %v", repo.deletedRuleIDs)
	}
}

// TestDeleteRuleAllowsOtherRows checks that a non-admin matrix row is still
// deleted and the change is applied to the engine (the reload reads follow).
func TestDeleteRuleAllowsOtherRows(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{
		activeRules: []sqlc.ListActivePresetRulesRow{
			{ID: 42, Preset: userdomain.PresetProcessOwner, Resource: "task", Action: "view", Scope: "parent"},
		},
		routePolicies: defaultRoutePolicies(),
	}
	svc := newAuthzTestService(repo)

	if err := svc.DeleteRule(context.Background(), 42); err != nil {
		t.Fatalf("DeleteRule() error = %v", err)
	}
	if !slices.Equal(repo.deletedRuleIDs, []int64{42}) {
		t.Errorf("deleted rule ids = %v, want [42]", repo.deletedRuleIDs)
	}
	want := append([]string{"ListActiveRules", "DeleteRule"}, reloadCalls()...)
	if !slices.Equal(repo.callLog, want) {
		t.Errorf("call order = %v, want %v", repo.callLog, want)
	}
}

// TestResetHappyPath checks that Reset seeds the default matrix and route
// policies through a single ResetPolicies call and then applies the new state
// to the engine (PolicyStore.Reload runs its read sequence).
func TestResetHappyPath(t *testing.T) {
	t.Parallel()
	repo := &stubPolicyRepo{routePolicies: defaultRoutePolicies()}
	svc := newAuthzTestService(repo)

	if err := svc.Reset(context.Background(), 5); err != nil {
		t.Fatalf("Reset() error = %v", err)
	}
	if repo.resetCalls != 1 {
		t.Errorf("ResetPolicies calls = %d, want 1", repo.resetCalls)
	}
	wantRules := defaultRuleParams(5)
	if !sameRuleSet(repo.persistedRules, wantRules) {
		t.Errorf("seeded rules = %v, want the default matrix set", repo.persistedRules)
	}
	for _, r := range repo.persistedRules {
		if !r.UpdatedBy.Valid || r.UpdatedBy.Int64 != 5 {
			t.Errorf("rule %s/%s updated_by = %+v, want user 5", r.Preset, r.Resource, r.UpdatedBy)
		}
	}
	wantPolicies := defaultPolicyParams(5)
	if !samePolicySet(repo.persistedPolicies, wantPolicies) {
		t.Errorf("seeded policies = %v, want the default route-policy set", repo.persistedPolicies)
	}
	for _, p := range repo.persistedPolicies {
		if !p.Active || !p.UpdatedBy.Valid || p.UpdatedBy.Int64 != 5 {
			t.Errorf("policy %q = %+v, want active and updated by user 5", p.Name, p)
		}
	}
	// The repository calls happen in order: the seed first, then the reload
	// reads of the engine apply.
	wantLog := append([]string{"ResetPolicies"}, reloadCalls()...)
	if !slices.Equal(repo.callLog, wantLog) {
		t.Errorf("call order = %v, want %v", repo.callLog, wantLog)
	}
}

// TestResetFailureRollsBackAndSkipsApply checks that a failed reset leaves the
// persisted state exactly as it was before (no residual deletes or inserts)
// and never applies the half-seeded state to the engine.
func TestResetFailureRollsBackAndSkipsApply(t *testing.T) {
	t.Parallel()
	oldRules := []sqlc.UpsertPresetRuleParams{
		{Preset: "legacy", Resource: "project", Action: "view", Scope: "all"},
	}
	oldPolicies := []sqlc.UpsertRoutePolicyParams{
		{Name: "legacy.route", Kind: "entity", Params: json.RawMessage("{}"), Active: true},
	}
	repo := &stubPolicyRepo{
		failOnInsert:      3,
		persistedRules:    slices.Clone(oldRules),
		persistedPolicies: slices.Clone(oldPolicies),
		routePolicies:     defaultRoutePolicies(),
	}
	svc := newAuthzTestService(repo)

	if err := svc.Reset(context.Background(), 5); err == nil {
		t.Fatal("Reset() succeeded although the third insert failed")
	}
	// Every mutation of the failed reset was rolled back: the persisted state
	// is still the pre-reset state, not the partially reseeded one.
	if !slices.Equal(repo.persistedRules, oldRules) {
		t.Errorf("rules after failed reset = %v, want the pre-reset state %v", repo.persistedRules, oldRules)
	}
	if !equalPolicies(repo.persistedPolicies, oldPolicies) {
		t.Errorf("policies after failed reset = %v, want the pre-reset state %v", repo.persistedPolicies, oldPolicies)
	}
	// apply() must not run on a failed reset: the engine keeps its snapshot.
	if !slices.Equal(repo.callLog, []string{"ResetPolicies"}) {
		t.Errorf("calls after failed reset = %v, want only the reset (no apply)", repo.callLog)
	}
}
