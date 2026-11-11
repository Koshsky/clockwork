package creds_test

import (
	"strings"
	"testing"

	"github.com/Koshsky/erp-backend/internal/security/creds"
)

func TestValidatePassword(t *testing.T) {
	t.Parallel()

	valid := []struct{ name, password, login string }{
		{"letters+digits", "abc12345", "user1"},
		{"lowercase only with digit", "abcdef1h", "user1"},
		{"phrase with spaces", "my pass phrase 1", "user1"},
		{"cyrillic + digit", "пароль1пароль1", "user1"},
		{"emoji + digit", "🔐secret1🔐secret1", "user1"},
		{"64 chars exactly", "a1" + strings.Repeat("x", 62), "user1"},
	}
	for _, tc := range valid {
		t.Run("valid/"+tc.name, func(t *testing.T) {
			t.Parallel()
			if err := creds.ValidatePassword(tc.password, tc.login); err != nil {
				t.Fatalf("пароль %q должен проходить: %v", tc.password, err)
			}
		})
	}

	invalid := []struct {
		name, password, login string
	}{
		{"too short", "abc1234", "user1"},
		{"too long", "a1" + strings.Repeat("x", 63), "user1"},
		{"no digit", "passwordpassword", "user1"},
		{"no letter", "1234567890", "user1"},
		{"weak password", "password", "user1"},
		{"weak 12345678", "12345678", "user1"},
		{"weak qwerty", "qwerty", "user1"},
		{"weak admin", "admin", "user1"},
		{"weak password uppercase", "PASSWORD", "user1"},
		{"contains login", "user1secret01", "user1"},
		{"contains login mixed case", "User1Secret01", "user1"},
	}
	for _, tc := range invalid {
		t.Run("invalid/"+tc.name, func(t *testing.T) {
			t.Parallel()
			if err := creds.ValidatePassword(tc.password, tc.login); err == nil {
				t.Fatalf("пароль %q должен отклоняться", tc.password)
			}
		})
	}
}
