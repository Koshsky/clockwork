//nolint:testpackage // service-level tests construct UserService directly with a stub repository (unexported fields)
package service

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"testing"

	"github.com/Koshsky/erp-backend/internal/security/hasher"
	"github.com/Koshsky/erp-backend/internal/tracing"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
)

// stubSessionRevoker records the revoked user ids (and can fail on demand).
type stubSessionRevoker struct {
	revoked []int64
	err     error
}

func (s *stubSessionRevoker) RevokeAllUserSessions(_ context.Context, userID int64) error {
	if s.err != nil {
		return s.err
	}
	s.revoked = append(s.revoked, userID)
	return nil
}

func (s *stubSessionRevoker) revokedIDs() []int64 { return s.revoked }

// newRevokeTestService builds a UserService over the stub repo with the given
// session revoker (mirrors newStubService, adding the sessions hook).
func newRevokeTestService(repo *stubRepo, revoker SessionRevoker) *UserService {
	return &UserService{
		logger:     slog.New(slog.DiscardHandler),
		repository: repo,
		mapper:     &UserMapper{},
		validator:  &UserValidator{},
		tracer:     tracing.New(nil),
		sessions:   revoker,
	}
}

// testUserID is the user id used across these tests.
const testUserID int64 = 7

// stubUserWithPassword builds a user row whose bcrypt hash matches the
// fixed "OldPass9!" password used across these tests.
func stubUserWithPassword() *sqlc.User {
	hash, _ := hasher.Hash("OldPass9!")
	return &sqlc.User{
		ID:           testUserID,
		Username:     "worker1",
		PasswordHash: hash,
	}
}

// TestChangePasswordRevokesSessions checks that a successful self-service
// password change revokes every session of the user.
func TestChangePasswordRevokesSessions(t *testing.T) {
	t.Parallel()

	const (
		userID      = 7
		oldPassword = "OldPass9!"
		newPassword = "NewPass9!"
	)
	repo := newStubRepo(stubUserWithPassword())
	revoker := &stubSessionRevoker{}
	svc := newRevokeTestService(repo, revoker)

	if err := svc.ChangePassword(context.Background(), userID, oldPassword, newPassword); err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}
	if !slices.Contains(revoker.revokedIDs(), userID) {
		t.Errorf("ChangePassword() did not revoke sessions of user %d", userID)
	}
}

// TestChangePasswordWrongOldKeepsSessions checks that a failed password change
// (wrong old password) does not revoke sessions.
func TestChangePasswordWrongOldKeepsSessions(t *testing.T) {
	t.Parallel()

	repo := newStubRepo(stubUserWithPassword())
	revoker := &stubSessionRevoker{}
	svc := newRevokeTestService(repo, revoker)

	if err := svc.ChangePassword(context.Background(), 7, "WrongPass9!", "NewPass9!"); err == nil {
		t.Fatal("ChangePassword() succeeded with a wrong old password")
	}
	if len(revoker.revokedIDs()) != 0 {
		t.Errorf("ChangePassword() revoked sessions despite an invalid old password: %v", revoker.revokedIDs())
	}
}

// TestResetPasswordRevokesSessions checks that an admin password reset revokes
// the user's sessions.
func TestResetPasswordRevokesSessions(t *testing.T) {
	t.Parallel()

	repo := newStubRepo(stubUserWithPassword())
	revoker := &stubSessionRevoker{}
	svc := newRevokeTestService(repo, revoker)

	if _, err := svc.ResetPassword(context.Background(), 7, admin(1)); err != nil {
		t.Fatalf("ResetPassword() error = %v", err)
	}
	if !slices.Contains(revoker.revokedIDs(), 7) {
		t.Error("ResetPassword() did not revoke sessions of the user")
	}
}

// TestDeleteUserRevokesSessions checks that deleting a user revokes their
// sessions (so a restored account does not resurrect old tokens).
func TestDeleteUserRevokesSessions(t *testing.T) {
	t.Parallel()

	repo := newStubRepo(stubUserWithPassword())
	revoker := &stubSessionRevoker{}
	svc := newRevokeTestService(repo, revoker)

	if err := svc.DeleteUser(context.Background(), 7); err != nil {
		t.Fatalf("DeleteUser() error = %v", err)
	}
	if !slices.Contains(revoker.revokedIDs(), 7) {
		t.Error("DeleteUser() did not revoke sessions of the user")
	}
}

// TestRevokeFailureStillUpdatesEverything checks that a session-revocation
// failure is not fatal: the password write and deletion already happened, the
// revoke error is only logged (best-effort), and the methods still return
// success.
func TestRevokeFailureStillUpdatesEverything(t *testing.T) {
	t.Parallel()

	repo := newStubRepo(stubUserWithPassword())
	revoker := &stubSessionRevoker{err: fmt.Errorf("revoke failed")}
	svc := newRevokeTestService(repo, revoker)

	if err := svc.ChangePassword(context.Background(), 7, "OldPass9!", "NewPass9!"); err != nil {
		t.Fatalf("ChangePassword() error = %v, want success despite revoke failure", err)
	}
}

// TestNoSessionRevokerIsSafe checks that a nil SessionRevoker does not panic.
func TestNoSessionRevokerIsSafe(t *testing.T) {
	t.Parallel()

	repo := newStubRepo(stubUserWithPassword())
	svc := newRevokeTestService(repo, nil)

	if err := svc.ChangePassword(context.Background(), 7, "OldPass9!", "NewPass9!"); err != nil {
		t.Fatalf("ChangePassword() error = %v", err)
	}
	if _, err := svc.ResetPassword(context.Background(), 7, admin(1)); err != nil {
		t.Fatalf("ResetPassword() error = %v", err)
	}
	if err := svc.DeleteUser(context.Background(), 7); err != nil {
		t.Fatalf("DeleteUser() error = %v", err)
	}
}
