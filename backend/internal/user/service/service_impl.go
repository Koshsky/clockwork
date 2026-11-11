package service

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
	repo "github.com/Koshsky/erp-backend/internal/user/repository"

	"github.com/Koshsky/erp-backend/internal/security/creds"
	"github.com/Koshsky/erp-backend/internal/security/hasher"
	"github.com/Koshsky/erp-backend/internal/security/hibp"
	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/dto"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// RBACReloader is an optional hook to refresh the in-memory RBAC snapshot
// (presets + per-user rights) after a user mutation; implemented by the
// rbacpolicy PolicyStore. Nil — rights changes propagate via the TTL refresh.
type RBACReloader interface {
	Reload(ctx context.Context) error
}

// SessionRevoker is an optional hook that revokes every active refresh session
// of a user after a credential change or account deletion; implemented by the
// auth repository. Nil — sessions are not revoked (best-effort hook).
type SessionRevoker interface {
	RevokeAllUserSessions(ctx context.Context, userID int64) error
}

type UserService struct {
	logger     *slog.Logger
	repository UserRepository
	mapper     *UserMapper
	validator  *UserValidator
	tracer     *tracingpkg.Tracer
	rbac       RBACReloader
	sessions   SessionRevoker
	hibp       *hibp.Checker
}

// maxManagerDepth — guard against an infinite loop while walking the manager hierarchy.
const maxManagerDepth = 1000

// maxUsernameSuffixAttempts — how many numeric suffixes generateUsername tries
// before giving up with a clear error instead of probing the DB indefinitely.
const maxUsernameSuffixAttempts = 1000

// NewUserService builds the UserService service.
func NewUserService(
	logger *slog.Logger,
	tracer *tracingpkg.Tracer,
	r *repo.UserRepository,
	rbac RBACReloader,
	sessions SessionRevoker,
	hibpChecker *hibp.Checker,
) *UserService {
	return &UserService{
		logger:     logger.With("component", "user_service"),
		repository: r,
		mapper:     &UserMapper{},
		validator:  &UserValidator{},
		tracer:     tracer,
		rbac:       rbac,
		sessions:   sessions,
		hibp:       hibpChecker,
	}
}

func (s *UserService) FindUserByID(ctx context.Context, id int64) (*dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.FindUserByID")
	defer end(nil)
	return s.FindUser(ctx, id)
}

func (s *UserService) ChangePassword(ctx context.Context, userID int64, oldPassword, newPassword string) error {
	ctx, end := s.tracer.Start(ctx, "user.ChangePassword")
	defer end(nil)

	user, err := s.FindUserByID(ctx, userID)
	if err != nil {
		return errors.NotFound("user not found")
	}

	// Complexity policy — checked before the old password (AD-09): the format of
	// the new password reveals nothing about the current one. The account login
	// is passed for the "must not contain the login" rule.
	if policyErr := creds.ValidatePassword(newPassword, user.Username); policyErr != nil {
		return policyErr
	}

	// Optional HIBP breach check — best-effort: network failures skip it.
	if s.hibp != nil {
		compromised, hibpErr := s.hibp.Check(ctx, newPassword)
		if hibpErr != nil {
			s.logger.WarnContext(ctx, "hibp check skipped", "error", hibpErr)
		} else if compromised {
			return errors.BadRequest("пароль был скомпрометирован в утечках — выберите другой")
		}
	}

	if err = hasher.Compare(user.PasswordHash, oldPassword); err != nil {
		return errors.NewValidationError("неверный текущий пароль")
	}

	newHash, err := hasher.Hash(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash password")
	}

	if err = s.repository.UpdatePassword(ctx, userID, newHash); err != nil {
		return err
	}

	// The password changed: every existing refresh session must die so a
	// stolen refresh token cannot keep refreshing under the new credentials.
	s.revokeSessions(ctx, userID)
	return nil
}

// CreateUserWithCreds creates a user and returns the generated password (if any)
// for the admin UI. The password is shown exactly once. Preset assignment on
// creation is admin-only (user_admin.create is grantable, but preset escalation
// stays an admin privilege — non-admin callers may only create workers).
func (s *UserService) CreateUserWithCreds(
	ctx context.Context,
	req dto.CreateUserRequest,
	caller userctx.UserContext,
) (*dto.CreateUserResult, error) {
	ctx, end := s.tracer.Start(ctx, "user.CreateUser")
	defer end(nil)
	return s.createUserInternal(ctx, req, caller)
}

// createUserInternal creates a user; when credentials are missing they are
// generated (the plaintext password is returned for one-time display).
func (s *UserService) createUserInternal(
	ctx context.Context,
	req dto.CreateUserRequest,
	caller userctx.UserContext,
) (*dto.CreateUserResult, error) {
	var generated string
	// Non-admin holders of user_admin.create may only create workers (a missing
	// preset defaults to worker); the other presets require the admin bypass.
	if !caller.Admin {
		if req.Preset == nil {
			req.Preset = new(userdomain.PresetWorker)
		}
		if *req.Preset != userdomain.PresetWorker {
			return nil, errors.ErrForbidden
		}
	}
	req.Username = NormalizeUsername(req.Username)
	if req.Username == "" {
		middleName := ""
		if req.MiddleName != nil {
			middleName = *req.MiddleName
		}
		username, err := s.generateUsername(
			ctx,
			req.LastName,
			req.FirstName,
			middleName,
			presetName(req.Preset),
		)
		if err != nil {
			return nil, err
		}
		req.Username = username
	}
	if IsUsernameReserved(req.Username) {
		return nil, errors.NewFieldErrorM(
			"username", "reserved", messages.M("user.login_reserved", req.Username),
		)
	}
	if req.PasswordHash == "" {
		raw, err := creds.RandomPassword()
		if err != nil {
			return nil, err
		}
		hash, err := hasher.Hash(raw)
		if err != nil {
			return nil, err
		}
		req.PasswordHash = hash
		generated = raw
	}
	// Individual overrides at creation: admin-only, validated like
	// /rbac/users/{id}/permissions.
	perms, permsErr := s.validateCreatePermissions(req.Permissions, caller)
	if permsErr != nil {
		return nil, permsErr
	}

	user := s.mapper.ToCreateUser(req)
	if err := s.validator.ValidateUser(&user); err != nil {
		return nil, err
	}

	created, err := s.repository.CreateUserWithPermissions(ctx, user, perms, caller.ID)
	if err != nil {
		return nil, err
	}
	s.refreshRBAC(ctx)

	return &dto.CreateUserResult{User: *s.mapper.ToDTO(created), Password: generated}, nil
}

// scopeAllCode — the "all" ownership scope code (grant default; mirrors the
// policies codec).
const scopeAllCode = "all"

// validateCreatePermissions validates the individual overrides of a created
// user: admin-only (like preset assignment) and each entry checked the same
// way as the per-user permissions endpoint (resource/action/scope codecs,
// scope applicability, no duplicates). Nil on an empty list.
func (s *UserService) validateCreatePermissions(
	req []dto.UserPermissionInput,
	caller userctx.UserContext,
) ([]userdomain.UserPermission, error) {
	if len(req) == 0 {
		return nil, nil
	}
	if !caller.Admin {
		return nil, errors.ErrForbidden
	}
	seen := map[string]bool{}
	out := make([]userdomain.UserPermission, 0, len(req))
	for _, p := range req {
		res, ok := engine.ParseResource(p.Resource)
		if !ok {
			return nil, errors.BadRequest("неизвестный ресурс " + p.Resource)
		}
		if action, okAction := engine.ParseAction(p.Action); !okAction || !engine.ActionApplicable(res, action) {
			return nil, errors.BadRequest("неизвестное действие " + p.Action)
		}
		key := p.Resource + "/" + p.Action
		if seen[key] {
			return nil, errors.BadRequest("дублируется право " + key)
		}
		seen[key] = true
		scope := scopeAllCode
		if p.Granted {
			parsed, okScope := engine.ParseScope(p.Scope)
			if !okScope || parsed == engine.ScopeNone {
				return nil, errors.BadRequest("недопустимая зона " + p.Scope + " (all|self|up1|up|sib|down|none)")
			}
			if !engine.ScopeApplicable(res, parsed) {
				return nil, errors.BadRequest("зона " + p.Scope + " неприменима к ресурсу " + p.Resource)
			}
			scope = p.Scope
		}
		out = append(out, userdomain.UserPermission{
			Resource: p.Resource,
			Action:   p.Action,
			Scope:    scope,
			Granted:  p.Granted,
		})
	}
	return out, nil
}

// generateUsername builds a unique login as `<translit(last)>.<initials>` —
// the surname transliteration plus the first letters of the given and middle
// names (e.g. «Шмонов Матвей Васильевич» → `shmonov.mv`); if taken, appends a
// numeric suffix; if there is nothing to transliterate — falls back to
// prefix+random suffix.
func (s *UserService) generateUsername(
	ctx context.Context,
	lastName, firstName, middleName, preset string,
) (string, error) {
	prefix := "user_"
	if preset == userdomain.PresetWorker {
		prefix = "worker_"
	}

	base := translitWithInitials(lastName, firstName, middleName)
	if base == "" {
		suffix, err := creds.RandomUsernameSuffix()
		if err != nil {
			return "", err
		}
		return prefix + suffix, nil
	}

	username := base
	for i := 2; i <= maxUsernameSuffixAttempts; i++ {
		exists, err := s.repository.UsernameExists(ctx, username)
		if err != nil {
			return "", err
		}
		if !exists {
			return username, nil
		}
		username = fmt.Sprintf("%s%d", base, i)
	}
	return "", errors.NewValidationError("не удалось сгенерировать свободный логин: исчерпаны все варианты")
}

// translitWithInitials — `<translit(last)>.<translit(first)[0]><translit(middle)[0]>`
// (e.g. «Шмонов Матвей Васильевич» → `shmonov.mv`), or just the surname when
// there are no name parts; ” when nothing transliterates.
func translitWithInitials(lastName, firstName, middleName string) string {
	last := creds.Transliterate(lastName)
	initials := firstLetter(firstName) + firstLetter(middleName)
	if last == "" {
		return initials
	}
	if initials == "" {
		return last
	}
	return last + "." + initials
}

// firstLetter — the first transliterated letter of a name part (” when empty).
func firstLetter(part string) string {
	t := creds.Transliterate(part)
	if t == "" {
		return ""
	}
	return t[:1]
}

// ResetPassword generates a new random password for the user and returns the
// raw password for one-time display. Admin-only: the route is reachable by
// user_admin.update holders, but resetting a password — like preset assignment
// — stays an admin privilege (a non-admin with the grant must not be able to
// reset any account, in particular an admin's, and take it over). The reset is
// recorded in the audit trail and the service log (never the raw password).
func (s *UserService) ResetPassword(ctx context.Context, id int64, caller userctx.UserContext) (string, error) {
	ctx, end := s.tracer.Start(ctx, "user.ResetPassword")
	defer end(nil)

	// Admin-only invariant (mirrors createUserInternal): the caller must carry
	// the admin bypass resolved by the RBAC store (EffectiveUser.Admin), not
	// merely an individual grant.
	if !caller.Admin {
		return "", errors.ErrForbidden
	}

	user, err := s.repository.FindUser(ctx, id)
	if err != nil || user == nil {
		return "", errors.NotFound("user not found")
	}

	raw, err := creds.RandomPassword()
	if err != nil {
		return "", err
	}
	hash, err := hasher.Hash(raw)
	if err != nil {
		return "", fmt.Errorf("failed to hash password")
	}
	if err = s.repository.UpdatePassword(ctx, id, hash); err != nil {
		return "", err
	}

	// Same as ChangePassword: a reset invalidates every existing session.
	s.revokeSessions(ctx, id)

	s.logger.InfoContext(
		ctx,
		"сброс пароля пользователя администратором",
		"user_id", id,
		"caller_id", caller.ID,
	)
	return raw, nil
}

func (s *UserService) FindUserByUsername(ctx context.Context, username string) (*dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.FindUserByUsername")
	defer end(nil)

	user, err := s.repository.FindUserByUsername(ctx, username)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTO(user), nil
}

func (s *UserService) FindUser(ctx context.Context, id int64) (*dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.FindUser")
	defer end(nil)

	user, err := s.repository.FindUser(ctx, id)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.NotFound("user not found")
	}
	return s.mapper.ToDTO(user), nil
}

// UpdateUser updates a user. Preset assignment is the only admin-only business
// rule (escalation protection via checkPresetChange); manager_id and profile
// fields are covered by the user_admin.update right.
func (s *UserService) UpdateUser(
	ctx context.Context,
	id int64,
	req dto.UpdateUserRequest,
	caller userctx.UserContext,
	callerID int64,
) (*dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.UpdateUser")
	defer end(nil)

	user, err := s.repository.FindUser(ctx, id)
	if err != nil || user == nil {
		return nil, errors.NotFound("user not found")
	}

	if err = s.checkPresetChange(ctx, user, req.Preset, caller, callerID); err != nil {
		return nil, err
	}
	if req.ManagerID != nil {
		if err = s.validateManager(ctx, id, req.ManagerID); err != nil {
			return nil, err
		}
	}

	// A login change to a reserved system word is blocked (unchanged logins,
	// e.g. the seeded "admin" account, keep working); the format itself is
	// checked by ValidateUser afterwards.
	if req.Username != nil {
		newName := NormalizeUsername(*req.Username)
		if newName != user.Username && IsUsernameReserved(newName) {
			return nil, errors.NewFieldErrorM(
				"username", "reserved", messages.M("user.login_reserved", newName),
			)
		}
	}

	s.mapper.ApplyUpdateToUser(user, req)
	if err = s.validator.ValidateUser(user); err != nil {
		return nil, err
	}

	updated, err := s.repository.UpdateUser(ctx, *user)
	if err != nil {
		return nil, err
	}
	s.refreshRBAC(ctx)

	return s.mapper.ToDTO(updated), nil
}

// checkPresetChange validates a preset change: only admin, not on self, and
// never removing the last active admin.
func (s *UserService) checkPresetChange(
	ctx context.Context,
	user *sqlc.User,
	newPreset *string,
	caller userctx.UserContext,
	callerID int64,
) error {
	if newPreset == nil {
		return nil
	}
	if !caller.Admin {
		return errors.ErrForbidden
	}
	if user.ID == callerID {
		return errors.NewValidationError("нельзя менять пресет прав самому себе")
	}
	if *newPreset == userdomain.PresetAdmin || !user.Preset.Valid || user.Preset.String != userdomain.PresetAdmin {
		return nil
	}
	admins, err := s.repository.CountUsers(ctx, 0, rbac.ListScope{All: true}, userdomain.PresetAdmin, 0, "")
	if err != nil {
		return err
	}
	if admins <= 1 {
		return errors.NewValidationError("нельзя снять последнего админа")
	}
	return nil
}

// refreshRBAC best-effort refresh of the in-memory RBAC snapshot after a user
// mutation (preset/account changes must take effect immediately on this
// instance; the TTL refresh heals on failure).
func (s *UserService) refreshRBAC(ctx context.Context) {
	if s.rbac == nil {
		return
	}
	if err := s.rbac.Reload(ctx); err != nil {
		s.logger.WarnContext(ctx, "user: обновление RBAC-снапшота не удалось (исправится фоновым TTL)", "error", err)
	}
}

// revokeSessions — best-effort session invalidation after a credential change
// or account deletion. A failure is logged loudly; the session table lives
// outside the user write, so the update cannot be rolled back (a DB failure
// here would also have failed the write itself).
func (s *UserService) revokeSessions(ctx context.Context, userID int64) {
	if s.sessions == nil {
		return
	}
	if err := s.sessions.RevokeAllUserSessions(ctx, userID); err != nil {
		s.logger.ErrorContext(ctx,
			"user: не удалось отозвать сессии пользователя",
			"user_id", userID,
			"error", err,
		)
	}
}

// presetName unwraps a preset pointer ("" — none).
func presetName(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// UpdateManager explicitly sets (or clears) a user's manager. Covered by the
// user_admin.update right (grantable); the manager cannot be the user themself
// and cycles are rejected.
func (s *UserService) UpdateManager(
	ctx context.Context,
	id int64,
	managerID *int64,
) (*dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.UpdateManager")
	defer end(nil)

	user, err := s.repository.FindUser(ctx, id)
	if err != nil || user == nil {
		return nil, errors.NotFound("user not found")
	}
	if err = s.validateManager(ctx, id, managerID); err != nil {
		return nil, err
	}

	user.ManagerID = nullable.ToInt8(managerID)
	if err = s.validator.ValidateUser(user); err != nil {
		return nil, err
	}
	updated, err := s.repository.UpdateUser(ctx, *user)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTO(updated), nil
}

// validateManager checks that the manager assignment is valid: it is not the
// user themself, the manager exists and is active, and the assignment does not
// create a circular dependency (walking up the manager_id chain).
// managerID == nil — clearing, allowed.
func (s *UserService) validateManager(ctx context.Context, userID int64, managerID *int64) error {
	if managerID == nil {
		return nil
	}
	if *managerID == userID {
		return errors.NewValidationError("руководитель не может быть самим пользователем")
	}

	manager, err := s.repository.FindUser(ctx, *managerID)
	if err != nil || manager == nil {
		return errors.NotFound("руководитель не найден")
	}

	cur := manager.ManagerID
	depth := 0
	for cur.Valid {
		depth++
		if depth > maxManagerDepth {
			return errors.NewValidationError("иерархия руководителей слишком глубокая")
		}
		if cur.Int64 == userID {
			return errors.NewValidationError("кольцевая зависимость в руководстве не допускается")
		}
		u, ferr := s.repository.FindUser(ctx, cur.Int64)
		if ferr != nil || u == nil {
			return errors.NotFound("руководитель не найден")
		}
		cur = u.ManagerID
	}
	return nil
}

func (s *UserService) DeleteUser(ctx context.Context, id int64) error {
	ctx, end := s.tracer.Start(ctx, "user.DeleteUser")
	defer end(nil)

	// Fail early with a human-readable list of blocking records instead of a
	// bare FK violation. The delete itself still guards against races via
	// mapUserDeleteErr in the repository.
	refs, err := s.repository.UserReferences(ctx, id)
	if err != nil {
		return err
	}
	if msg := userReferencesConflict(refs); msg != "" {
		return errors.Conflict(msg)
	}

	if err = s.repository.DeleteUser(ctx, id); err != nil {
		return err
	}

	// The account is gone (moved to users_deleted): revoke sessions so a
	// deleted user cannot refresh, and a restored account does not resurrect
	// old tokens.
	s.revokeSessions(ctx, id)
	// The deleted user must leave the in-memory principals immediately, not
	// after the next TTL reload (~30 s): their still-valid access token would
	// otherwise keep granting rights while the account is gone.
	s.refreshRBAC(ctx)
	return nil
}

// userReferencesConflict renders a 409 message listing the records that
// reference the user; an empty string means nothing blocks the deletion.
func userReferencesConflict(refs sqlc.ListUserReferencesRow) string {
	type refGroup struct {
		count int64
		label string
	}
	groups := []refGroup{
		{refs.Managees, "подчинённые"},
		{refs.Resources, "ресурсы"},
		{refs.Projects, "проекты"},
		{refs.Processes, "процессы"},
		{refs.Tasks, "задачи"},
		{refs.Comments, "комментарии"},
		{refs.AutoCreateTemplates, "шаблоны автосоздания"},
	}
	parts := make([]string, 0, len(groups))
	for _, g := range groups {
		if g.count > 0 {
			parts = append(parts, fmt.Sprintf("%s — %d", g.label, g.count))
		}
	}
	if len(parts) == 0 {
		return ""
	}
	return "пользователя нельзя удалить: на него ссылаются " + strings.Join(parts, ", ") +
		" — сначала переназначьте или удалите их"
}

// NormalizeSearch validates and prepares the free-text search pattern of the
// user list — the delivery layer entry point (see UserValidator.ValidateSearch).
func (s *UserService) NormalizeSearch(search string) (string, error) {
	return s.validator.ValidateSearch(search)
}

// ListUsers returns a paged list of users; visibility by manager is enforced
// in the middleware (vp sees only their own subordinates). search is an
// optional case-insensitive substring over the full name or the login; an empty
// string (or a pattern without searchable characters) disables the filter.
func (s *UserService) ListUsers(
	ctx context.Context,
	userID int64,
	scope rbac.ListScope,
	presetFilter string,
	managerID int64,
	search string,
	limit, offset int,
) ([]dto.UserResponse, int64, error) {
	ctx, end := s.tracer.Start(ctx, "user.ListUsers")
	defer end(nil)

	search = normalizeSearch(search)
	users, err := s.repository.ListUsers(ctx, userID, scope, presetFilter, managerID, search, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	total, err := s.repository.CountUsers(ctx, userID, scope, presetFilter, managerID, search)
	if err != nil {
		return nil, 0, err
	}
	return s.mapper.ToDTOs(users), total, nil
}

// ListAllUsers returns every active user (unscoped; used for owner pickers).
func (s *UserService) ListAllUsers(ctx context.Context) ([]dto.UserResponse, error) {
	ctx, end := s.tracer.Start(ctx, "user.ListAllUsers")
	defer end(nil)

	users, err := s.repository.ListAllUsers(ctx)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToDTOs(users), nil
}

func (s *UserService) ListStates(
	ctx context.Context,
	userID int64,
	start, end date.Date,
) ([]dto.UserStateResponse, error) {
	ctx, finish := s.tracer.Start(ctx, "user.ListStates")
	defer finish(nil)

	if err := s.validator.ValidatePositiveID(userID, "user_id"); err != nil {
		return nil, err
	}
	if err := s.validator.ValidateDayRange(start, end); err != nil {
		return nil, err
	}

	if err := s.ensureUserExists(ctx, userID); err != nil {
		return nil, err
	}

	states, err := s.repository.ListStates(ctx, userID, start, end)
	if err != nil {
		return nil, err
	}
	return s.mapper.ToStateDTOs(states), nil
}

// ListStatesBatch returns the calendar states of several workers over one date
// range. It is the batch replacement of N sequential ListStates calls (one per
// employee on screen): the same validation, one query for the whole set, and an
// entry for every requested user — including workers with no states in the
// range (empty days), so the client never has to guess. Every requested id is
// authorized like the single endpoint: only ids the caller may view
// (worker.view — own subordinates, self without a manager, or all for admins)
// are served; a denied id 404s without disclosing existence.
func (s *UserService) ListStatesBatch(
	ctx context.Context,
	caller userctx.UserContext,
	userIDs []int64,
	start, end date.Date,
) ([]dto.UserStatesResponse, error) {
	ctx, finish := s.tracer.Start(ctx, "user.ListStatesBatch")
	defer finish(nil)

	if err := s.validator.ValidatePositiveIDs(userIDs, "ids"); err != nil {
		return nil, err
	}
	if err := s.validator.ValidateDayRange(start, end); err != nil {
		return nil, err
	}

	ids, err := s.checkBatchScopes(ctx, caller, userIDs)
	if err != nil {
		return nil, err
	}

	states, err := s.repository.ListStatesByUsers(ctx, ids, start, end)
	if err != nil {
		return nil, err
	}

	// Rows arrive ordered by user_id; grouping keeps that order and every id
	// from the request is present, so the result mirrors the ids slice.
	grouped := make(map[int64][]dto.UserStateResponse, len(ids))
	for _, state := range s.mapper.ToBatchStateDTOs(states) {
		grouped[state.UserID] = append(grouped[state.UserID], state)
	}
	out := make([]dto.UserStatesResponse, 0, len(ids))
	for _, id := range ids {
		days := grouped[id]
		if days == nil {
			days = []dto.UserStateResponse{}
		}
		out = append(out, dto.UserStatesResponse{UserID: id, Days: days})
	}
	return out, nil
}

// checkBatchScopes verifies existence and the worker.view scope of every
// requested id (deduplicated, order preserved) and returns the allowed set.
// The owners are loaded in a single query; the (in-memory) authorize checks
// then run over the fetched rows — no per-id round trips (the old check was
// 1+N FindUser calls).
func (s *UserService) checkBatchScopes(
	ctx context.Context,
	caller userctx.UserContext,
	userIDs []int64,
) ([]int64, error) {
	ids := dedupeIDs(userIDs)

	rows, err := s.repository.ListUserManagers(ctx, ids)
	if err != nil {
		return nil, err
	}
	// The owner of a worker row is the manager, or the worker themself when
	// there is none — exactly the chain OwnerChain resolves for worker.view.
	owners := make(map[int64]int64, len(rows))
	for _, row := range rows {
		owner := row.ID
		if row.ManagerID.Valid {
			owner = row.ManagerID.Int64
		}
		owners[row.ID] = owner
	}

	for _, id := range ids {
		owner, ok := owners[id]
		if !ok {
			return nil, errors.ErrUserNotFound
		}
		if !engine.AuthorizeUser(caller, rbac.ResourceWorker, engine.ActionView, rbac.Owners{Owner: owner}, caller.ID) {
			return nil, errors.ErrUserNotFound
		}
	}
	return ids, nil
}

// dedupeIDs drops repeated ids, preserving the first-occurrence order.
func dedupeIDs(ids []int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	out := make([]int64, 0, len(ids))
	for _, id := range ids {
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}

func (s *UserService) SetDays(
	ctx context.Context,
	userID int64,
	req dto.SetDaysRequest,
) error {
	ctx, end := s.tracer.Start(ctx, "user.SetDays")
	defer end(nil)

	if err := s.validator.ValidatePositiveID(userID, "user_id"); err != nil {
		return err
	}
	if err := s.validator.ValidatePositiveID(req.StateID, "state_id"); err != nil {
		return err
	}
	if err := s.validator.ValidateDayRange(req.StartDate, req.EndDate); err != nil {
		return err
	}

	if err := s.ensureUserExists(ctx, userID); err != nil {
		return err
	}

	return s.repository.SetStateRange(ctx, userID, req.StateID, req.StartDate, req.EndDate)
}

func (s *UserService) DeleteDays(
	ctx context.Context,
	userID int64,
	start, end date.Date,
	stateID *int64,
) error {
	ctx, finish := s.tracer.Start(ctx, "user.DeleteDays")
	defer finish(nil)

	if err := s.validator.ValidatePositiveID(userID, "user_id"); err != nil {
		return err
	}
	if stateID != nil {
		if err := s.validator.ValidatePositiveID(*stateID, "state_id"); err != nil {
			return err
		}
	}
	if err := s.validator.ValidateDayRange(start, end); err != nil {
		return err
	}

	if err := s.ensureUserExists(ctx, userID); err != nil {
		return err
	}

	return s.repository.DeleteStateRange(ctx, userID, start, end, stateID)
}

// ensureUserExists verifies the user exists (404 otherwise).
func (s *UserService) ensureUserExists(ctx context.Context, userID int64) error {
	user, err := s.repository.FindUser(ctx, userID)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return errors.ErrUserNotFound
		}
		return err
	}
	if user == nil {
		return errors.ErrUserNotFound
	}
	return nil
}
