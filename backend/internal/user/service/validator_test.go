package service_test

import (
	"database/sql"
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	"github.com/Koshsky/erp-backend/internal/user/service"
)

// Presets are configured by the rbac_presets catalog: only the form is
// validated, existence is checked by the FK — so a new preset passes, a
// missing one (nil) is allowed, and an overly long one does not.
func TestValidateUserPreset(t *testing.T) {
	t.Parallel()
	v := &service.UserValidator{}
	base := sqlc.User{LastName: "И", FirstName: "И", Username: "user1"}

	// No preset is valid: a user may have only individual permissions.
	if err := v.ValidateUser(&base); err != nil {
		t.Fatalf("пустой пресет должен проходить валидацию: %v", err)
	}
	long := base
	longPreset := strings.Repeat("a", 33)
	long.Preset = sql.NullString{String: longPreset, Valid: true}
	if err := v.ValidateUser(&long); err == nil {
		t.Fatal("пресет длиннее 32 должен давать ошибку")
	}
	for _, preset := range []string{"auditor", "vp", "worker"} {
		r := base
		r.Preset = sql.NullString{String: preset, Valid: true}
		if err := v.ValidateUser(&r); err != nil {
			t.Errorf("пресет %q должен проходить валидацию: %v", preset, err)
		}
	}
}

// Logins are always validated as usernames: strict charset/length rule,
// normalized to lowercase, reserved system words rejected on new values.
func TestValidateUsername(t *testing.T) {
	t.Parallel()
	v := &service.UserValidator{}

	valid := []string{"user", "user_1", "i.vanov", "a.b_c.d", "123abc", "ab1"}
	for _, u := range valid {
		t.Run("valid/"+u, func(t *testing.T) {
			t.Parallel()
			if err := v.ValidateUsername(u); err != nil {
				t.Errorf("логин %q должен проходить: %v", u, err)
			}
		})
	}

	invalid := []string{
		"ab",                    // too short
		strings.Repeat("a", 21), // too long
		"1user!",                // banned char
		"user@example",          // email is not a username
		"user name",             // space
		"ivanov-1",              // dash not allowed
		"Привет1",               // cyrillic
		".user",                 // starts with dot
		"_user",                 // starts with underscore
	}
	for _, u := range invalid {
		t.Run("invalid/"+u, func(t *testing.T) {
			t.Parallel()
			if err := v.ValidateUsername(u); err == nil {
				t.Errorf("логин %q должен отклоняться", u)
			}
		})
	}
}

func TestNormalizeUsername(t *testing.T) {
	t.Parallel()

	if got := service.NormalizeUsername("  Ivanov  "); got != "ivanov" {
		t.Errorf("нормализация: получили %q, ожидали \"ivanov\"", got)
	}
	for _, reserved := range []string{"admin", "support", "root", "system", "help"} {
		if !service.IsUsernameReserved(reserved) {
			t.Errorf("%q должен быть зарезервирован", reserved)
		}
	}
	if service.IsUsernameReserved("admin1") || service.IsUsernameReserved("user") {
		t.Error("не-точные совпадения не должны быть зарезервированы")
	}
}
