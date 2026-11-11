package service

import (
	"context"
	"fmt"

	"github.com/Koshsky/erp-backend/internal/security/creds"
	"github.com/Koshsky/erp-backend/internal/security/hasher"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	nullable "github.com/Koshsky/erp-backend/pkg/database"
)

// Bootstrap administrator: the account is created on the first launch from the
// ADMIN_PASSWORD environment variable instead of shipping in the seeds — a
// seeded hash would be one known credential in every deployment.
//
// The login is a code invariant: "admin" is a reserved username
// (IsUsernameReserved) and the admin preset tag, so only the password is
// configurable.
const (
	adminLogin     = userdomain.PresetAdmin
	adminLastName  = "Admin"
	adminFirstName = "Name"
)

// EnsureAdmin creates the administrator account when it is missing and reports
// whether it created one. Idempotent by design: an existing account is left
// untouched — the password is never rotated, so a changed ADMIN_PASSWORD does
// not lock an operator out of a running deployment. A missing account with an
// empty password is an error: the deployment would come up without any
// administrator at all.
//
// The operator-provided password does not go through the user-facing policy
// (that one guards self-service changes, including the breach check); a
// password the policy rejects is only reported as a warning.
func (s *UserService) EnsureAdmin(ctx context.Context, password string) (bool, error) {
	exists, err := s.repository.UsernameExists(ctx, adminLogin)
	if err != nil {
		return false, err
	}
	if exists {
		s.logger.InfoContext(ctx, "admin: аккаунт уже существует, бутстрап пропущен", "login", adminLogin)
		return false, nil
	}
	if password == "" {
		return false, fmt.Errorf("ADMIN_PASSWORD is required to create the %q account", adminLogin)
	}
	if policyErr := creds.ValidatePassword(password, adminLogin); policyErr != nil {
		s.logger.WarnContext(ctx,
			"admin: пароль не проходит пользовательскую политику (создаётся как есть)",
			"login", adminLogin,
			"reason", policyErr,
		)
	}

	hash, err := hasher.Hash(password)
	if err != nil {
		return false, err
	}
	created, err := s.repository.CreateUser(ctx, sqlc.User{
		LastName:     adminLastName,
		FirstName:    adminFirstName,
		Username:     adminLogin,
		Preset:       nullable.ToString(new(userdomain.PresetAdmin)),
		PasswordHash: hash,
	})
	if err != nil {
		return false, err
	}

	s.logger.InfoContext(ctx, "admin: аккаунт создан", "login", created.Username, "user_id", created.ID)
	s.refreshRBAC(ctx)
	return true, nil
}
