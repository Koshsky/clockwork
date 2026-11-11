package creds

import (
	"strings"
	"unicode"

	"github.com/Koshsky/erp-backend/pkg/errors"
)

// Password bounds (NIST SP 800-63B): at least 8, at most 64 characters — long
// enough for phrase passwords, short enough to never be truncated.
const (
	minPasswordLength = 8
	maxPasswordLength = 64
)

// ValidatePassword checks a user-chosen password against the password policy:
// length 8..64, at least one letter and one digit (any case), no well-known
// weak passwords, and the password must not contain the account login.
// All other characters (spaces, Cyrillic, emoji, repeats) are allowed.
// Applied only to user-chosen passwords (password change); admin-generated
// passwords are random and bypass the policy by design.
func ValidatePassword(password, login string) error {
	runes := []rune(password)
	if len(runes) < minPasswordLength || len(runes) > maxPasswordLength {
		return errors.BadRequest("пароль должен быть не короче 8 и не длиннее 64 символов")
	}

	var hasLetter, hasDigit bool
	for _, r := range runes {
		switch {
		case unicode.IsLetter(r):
			hasLetter = true
		case unicode.IsNumber(r):
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return errors.BadRequest("пароль должен содержать минимум одну букву и одну цифру")
	}

	lower := strings.ToLower(password)
	// Small always-on local blacklist; the larger breach check is delegated to
	// the optional HIBP range API (see internal/security/hibp).
	for _, w := range [...]string{"password", "12345678", "qwerty", "admin"} {
		if lower == w {
			return errors.BadRequest("пароль слишком простой — выберите менее распространённый")
		}
	}

	if login != "" && strings.Contains(lower, strings.ToLower(strings.TrimSpace(login))) {
		return errors.BadRequest("пароль не должен содержать логин пользователя")
	}

	return nil
}
