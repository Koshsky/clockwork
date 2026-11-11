package service

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/Koshsky/erp-backend/internal/authz/domain"
	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/authz/repository"
	"github.com/Koshsky/erp-backend/internal/authz/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
)

// reloadTimeout — budget of a single rule reload from the DB.
const reloadTimeout = 10 * time.Second

// PolicyStore keeps DB rules in memory and publishes them to the engine:
// the Casbin snapshot via engine.Publish (matrix + ACL rows + role
// assignments), the route checks via rbac.Middleware.Refresh, and the
// per-user principal snapshot (admin bypass, assigned preset, individual
// overrides) served to the auth middleware via EffectiveUser. When the DB is
// unavailable it runs on the built-in defaults and "heals" itself by TTL. No
// load error brings the service down: only a valid, consistent snapshot is
// applied.
type PolicyStore struct {
	logger   *slog.Logger
	repo     policyRepository
	mw       *rbac.Middleware
	interval time.Duration
	stop     chan struct{}

	mu      sync.RWMutex
	users   map[int64]userctx.UserContext
	started bool
}

// NewPolicyStore builds the policy store.
func NewPolicyStore(
	logger *slog.Logger,
	repo *repository.RuleRepository,
	mw *rbac.Middleware,
	interval config.Duration,
) *PolicyStore {
	return &PolicyStore{
		logger:   logger.With("component", "rbacpolicy_store"),
		repo:     repo,
		mw:       mw,
		interval: time.Duration(interval),
		stop:     make(chan struct{}),
		users:    map[int64]userctx.UserContext{},
	}
}

// Start performs the initial load (best-effort: when the DB is unavailable —
// a WARN and defaults) and starts the background TTL refresh.
func (s *PolicyStore) Start() {
	s.mu.Lock()
	s.started = true
	s.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), reloadTimeout)
	if err := s.Reload(ctx); err != nil {
		s.logger.WarnContext(ctx, "rbac: стартовая загрузка правил не удалась, работаю на дефолтах", "error", err)
	}
	cancel()
	go s.refreshLoop()
}

// refreshLoop periodically reloads rules from the DB (eventual
// consistency across instances; local mutations are applied immediately
// via Reload from the service).
func (s *PolicyStore) refreshLoop() {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stop:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), reloadTimeout)
			if err := s.Reload(ctx); err != nil {
				s.logger.WarnContext(
					ctx,
					"rbac: фоновая перезагрузка правил не удалась, остаюсь на последнем снапшоте",
					"error",
					err,
				)
			}
			cancel()
		}
	}
}

// Stop stops the background refresh (for graceful shutdown).
func (s *PolicyStore) Stop() {
	close(s.stop)
}

// Reload re-reads rules and user principals from the DB and publishes them to
// the engine: the Casbin snapshot (matrix + user ACL/revoke rows + role
// assignments) and the route checks. On any error (including an empty route
// policy set) the published state stays unchanged.
func (s *PolicyStore) Reload(ctx context.Context) error {
	rules, err := s.repo.ListActiveRules(ctx)
	if err != nil {
		return fmt.Errorf("загрузка правил: %w", err)
	}
	input := publishInput(rules)

	routePolicies, err := s.repo.ListActiveRoutePolicies(ctx)
	if err != nil {
		return fmt.Errorf("загрузка маршрутных проверок: %w", err)
	}
	if len(routePolicies) == 0 {
		return fmt.Errorf(
			"в БД нет ни одной активной маршрутной проверки — применение отменено (защита от полной блокировки)",
		)
	}
	built, err := engine.BuildPolicies(routePoliciesToSpecs(routePolicies))
	if err != nil {
		return fmt.Errorf("сборка маршрутных проверок: %w", err)
	}

	principals, err := s.loadPrincipals(ctx)
	if err != nil {
		return fmt.Errorf("загрузка прав пользователей: %w", err)
	}
	assignments, err := s.repo.ListUserPrincipals(ctx)
	if err != nil {
		return fmt.Errorf("загрузка пресетов пользователей: %w", err)
	}
	permissions, err := s.repo.ListAllUserPermissions(ctx)
	if err != nil {
		return fmt.Errorf("загрузка override-правил: %w", err)
	}
	for _, a := range assignments {
		if !a.Preset.Valid {
			continue
		}
		input.Roles = append(input.Roles, engine.RoleAssign{
			User:   strconv.FormatInt(a.UserID, 10),
			Preset: a.Preset.String,
		})
	}
	for _, p := range permissions {
		sub := strconv.FormatInt(p.UserID, 10)
		key := p.Resource + "/" + p.Action
		if p.Granted {
			input.Grants = append(input.Grants, engine.RuleGrant{Sub: sub, Key: key, Scope: p.Scope})
		} else {
			input.Denies = append(input.Denies, engine.RuleDeny{Sub: sub, Key: key})
		}
	}
	if err = engine.Publish(input); err != nil {
		return fmt.Errorf("сборка Casbin-политик: %w", err)
	}

	s.mw.Refresh(built)
	s.mu.Lock()
	s.users = principals
	s.mu.Unlock()
	return nil
}

// EffectiveUser returns the in-memory principal of a user (admin bypass,
// assigned preset, individual overrides). It never touches the DB per request:
// the snapshot is refreshed by Start/Reload. A missing entry (unknown or
// not-yet-loaded user) returns the default deny principal.
func (s *PolicyStore) EffectiveUser(_ context.Context, userID int64) (userctx.UserContext, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	u, ok := s.users[userID]
	if !ok {
		return userctx.UserContext{ID: userID}, nil
	}
	return u, nil
}

// loadPrincipals builds the user → principal snapshot: every active user with
// the assigned preset (admin preset ⇒ the admin bypass) and the individual
// overrides grouped by user.
func (s *PolicyStore) loadPrincipals(ctx context.Context) (map[int64]userctx.UserContext, error) {
	rows, err := s.repo.ListUserPrincipals(ctx)
	if err != nil {
		return nil, err
	}
	perms, err := s.repo.ListAllUserPermissions(ctx)
	if err != nil {
		return nil, err
	}
	overrides := make(map[int64][]userctx.PermissionRule, len(perms))
	for _, p := range perms {
		overrides[p.UserID] = append(overrides[p.UserID], userctx.PermissionRule{
			Resource: p.Resource,
			Action:   p.Action,
			Scope:    p.Scope,
			Granted:  p.Granted,
		})
	}
	users := make(map[int64]userctx.UserContext, len(rows))
	for _, row := range rows {
		preset := ""
		if row.Preset.Valid {
			preset = row.Preset.String
		}
		users[row.UserID] = userctx.UserContext{
			ID:     row.UserID,
			Admin:  preset == userdomain.PresetAdmin,
			Preset: preset,
			Rules:  overrides[row.UserID],
		}
	}
	return users, nil
}

// IsReady reports whether the store has completed at least one reload attempt
// (used by the auth middleware to fall back to the JWT preset before then).
func (s *PolicyStore) IsReady() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.started
}

// publishInput converts the preset matrix rows into Casbin allow rules. The
// codec validation (resource/action/scope) happens in engine.Publish — the
// same checks the old matrix loader performed.
func publishInput(rules []sqlc.ListActivePresetRulesRow) engine.PublishInput {
	input := engine.PublishInput{}
	for _, r := range rules {
		input.Grants = append(input.Grants, engine.RuleGrant{
			Sub:   r.Preset,
			Key:   r.Resource + "/" + r.Action,
			Scope: r.Scope,
		})
	}
	return input
}

// routePoliciesToSpecs converts route policy definitions into engine
// specifications (kind and parameter validation happens in BuildPolicies).
func routePoliciesToSpecs(routes []domain.RoutePolicy) []engine.RouteSpec {
	specs := make([]engine.RouteSpec, 0, len(routes))
	for _, p := range routes {
		specs = append(specs, engine.RouteSpec{Name: p.Name, Kind: p.Kind, Params: p.Params})
	}
	return specs
}
