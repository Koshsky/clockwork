//nolint:testpackage // service-level tests construct UserService directly with a stub repository (unexported fields)
package service

import (
	"context"
	"testing"

	"github.com/Koshsky/erp-backend/internal/security/hasher"
	userdomain "github.com/Koshsky/erp-backend/internal/user/domain"
	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
)

func findAdmin(repo *stubRepo) *sqlc.User {
	for _, u := range repo.users {
		if u.Username == adminLogin {
			return u
		}
	}
	return nil
}

// The first launch creates the administrator from the provided password: the
// account carries the admin preset and a hash that verifies the raw password
// (the seeds no longer ship a known credential).
func TestEnsureAdminCreatesAccount(t *testing.T) {
	t.Parallel()
	repo := newStubRepo()
	svc := newStubService(repo)

	created, err := svc.EnsureAdmin(context.Background(), "bootstrap-Secret-1")
	if err != nil {
		t.Fatalf("EnsureAdmin: %v", err)
	}
	if !created {
		t.Fatal("аккаунт должен быть создан")
	}
	admin := findAdmin(repo)
	if admin == nil {
		t.Fatalf("пользователь %q не создан", adminLogin)
	}
	if got := presetCode(admin.Preset); got != userdomain.PresetAdmin {
		t.Errorf("пресет %q, ожидался %q", got, userdomain.PresetAdmin)
	}
	if admin.LastName == "" || admin.FirstName == "" {
		t.Error("имя администратора не заполнено")
	}
	if err = hasher.Compare(admin.PasswordHash, "bootstrap-Secret-1"); err != nil {
		t.Errorf("хеш не соответствует паролю: %v", err)
	}
}

// An existing administrator is never touched: the password is not rotated, so a
// changed ADMIN_PASSWORD cannot lock an operator out of a running deployment.
func TestEnsureAdminSkipsExisting(t *testing.T) {
	t.Parallel()
	oldHash, err := hasher.Hash("old-password")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	repo := newStubRepo(userRow(1, adminLogin, "Admin", "Name", userdomain.PresetAdmin))
	repo.users[1].PasswordHash = oldHash
	svc := newStubService(repo)

	created, err := svc.EnsureAdmin(context.Background(), "another-password")
	if err != nil {
		t.Fatalf("EnsureAdmin: %v", err)
	}
	if created {
		t.Fatal("существующий аккаунт не должен пересоздаваться")
	}
	admin := findAdmin(repo)
	if admin == nil {
		t.Fatal("аккаунт потерян")
	}
	if err = hasher.Compare(admin.PasswordHash, "old-password"); err != nil {
		t.Errorf("пароль перезаписан: %v", err)
	}
}

// Without a password a missing administrator is a hard error: the service must
// not come up without any way to administer it.
func TestEnsureAdminRequiresPassword(t *testing.T) {
	t.Parallel()
	repo := newStubRepo()
	svc := newStubService(repo)

	if _, err := svc.EnsureAdmin(context.Background(), ""); err == nil {
		t.Fatal("пустой пароль должен вернуть ошибку")
	}
	if findAdmin(repo) != nil {
		t.Error("аккаунт не должен создаваться без пароля")
	}
}

// The operator's password is not filtered by the user-facing policy (which
// guards self-service changes): a weak one is accepted with a warning.
func TestEnsureAdminAcceptsWeakPassword(t *testing.T) {
	t.Parallel()
	repo := newStubRepo()
	svc := newStubService(repo)

	created, err := svc.EnsureAdmin(context.Background(), "admin")
	if err != nil {
		t.Fatalf("EnsureAdmin: %v", err)
	}
	if !created {
		t.Fatal("аккаунт должен быть создан несмотря на слабый пароль")
	}
	if err = hasher.Compare(findAdmin(repo).PasswordHash, "admin"); err != nil {
		t.Errorf("хеш не соответствует паролю: %v", err)
	}
}
