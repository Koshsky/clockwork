package service

import (
	"regexp"
	"strings"

	"github.com/Koshsky/erp-backend/internal/user/repository/sqlc"
	"github.com/Koshsky/erp-backend/pkg/date"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
	"github.com/Koshsky/erp-backend/pkg/validator"
)

// maxDayRange is the maximum calendar range width per request (in days).
// maxPresetLen is the maximum preset name length (RBAC catalog).
// maxBatchIDs is the maximum number of worker ids accepted by one batch request.
// maxSearchLen caps the search pattern length (an oversized pattern is rejected
// instead of being silently truncated).
const (
	maxDayRange  = 730
	maxPresetLen = 32
	maxBatchIDs  = 200
	maxSearchLen = 128
	hoursPerDay  = 24
)

// likeEscapeChar is the ESCAPE character of the LIKE patterns built by
// NormalizeSearch; a literal occurrence in the user input is escaped.
const likeEscapeChar = '\\'

// usernamePattern — the strict login rule: starts with a letter or digit, then
// letters/digits/./_, total length 3..20. Logins are always validated as
// usernames (email logins are not supported). Pattern assumes lowercase input.
const usernamePattern = "^[a-z0-9][a-z0-9._]{2,19}$"

// NormalizeUsername trims and lowercases a login (avoids User/user duplicates).
func NormalizeUsername(username string) string {
	return strings.ToLower(strings.TrimSpace(username))
}

// IsUsernameReserved reports whether the login equals a reserved system word.
func IsUsernameReserved(username string) bool {
	for _, r := range [...]string{"admin", "support", "root", "system", "help"} {
		if username == r {
			return true
		}
	}
	return false
}

type UserValidator struct {
	validator.Validator
}

func (v *UserValidator) ValidateUser(user *sqlc.User) error {
	if err := v.ValidateRequiredText(user.LastName, "last_name"); err != nil {
		return err
	}
	if err := v.ValidateRequiredText(user.FirstName, "first_name"); err != nil {
		return err
	}
	// Logins are always validated as usernames (no email variant), normalized
	// to lowercase before storage so the case-insensitive login matches.
	user.Username = NormalizeUsername(user.Username)
	if err := v.ValidateRequiredText(user.Username, "username"); err != nil {
		return err
	}
	if err := v.ValidateUsername(user.Username); err != nil {
		return err
	}
	// Presets are configured at runtime by the rbac_presets catalog: here we
	// only check the form (NULL — no base preset is allowed); preset existence
	// is guaranteed by the FK users_preset_fk — violations surface as 400 via
	// mapUserErr.
	if user.Preset.Valid && len(user.Preset.String) > maxPresetLen {
		return errors.NewFieldError("preset", "too_long", "preset is too long")
	}
	if user.ManagerID.Valid {
		if err := v.ValidatePositiveID(user.ManagerID.Int64, "manager_id"); err != nil {
			return err
		}
	}
	if user.HireDate.Valid && user.TerminationDate.Valid &&
		user.TerminationDate.Time.Before(user.HireDate.Time) {
		return errors.NewFieldError(
			"termination_date",
			"date_range",
			"termination_date must be greater than or equal to hire_date",
		)
	}
	return nil
}

// ValidateUsername checks the strict username rule (always as username, no
// email variant). Assumes the value is already trimmed and lowercased.
func (v *UserValidator) ValidateUsername(username string) error {
	ok, err := regexp.MatchString(usernamePattern, username)
	if err != nil || !ok {
		return errors.NewFieldError(
			"username",
			"format",
			"Логин: только латиница (a–z), цифры, точка и подчёркивание. Длина от 3 до 20 символов",
		)
	}
	return nil
}

// normalizeSearch prepares the free-text search pattern for the SQL LIKE
// filters: it trims and lowercases the input (the query compares
// LOWER(<columns>) LIKE '%' || pattern || '%'), escapes the LIKE metacharacters
// % _ and the escape character itself, and drops a pattern that carries no
// searchable character at all (so a query of "%" or "_" does not turn into
// "match everything"). An empty result disables the filter.
func normalizeSearch(search string) string {
	pattern := strings.ToLower(strings.TrimSpace(search))
	if pattern == "" {
		return ""
	}
	var b strings.Builder
	b.Grow(len(pattern))
	hasText := false
	for _, r := range pattern {
		if r == '%' || r == '_' || r == likeEscapeChar {
			b.WriteRune(likeEscapeChar)
		} else {
			hasText = true
		}
		b.WriteRune(r)
	}
	// A pattern built only of metacharacters has nothing to match.
	if !hasText {
		return ""
	}
	return b.String()
}

// ValidateSearch checks the search pattern length (measured before escaping, so
// it reflects what the user typed) and normalizes it. An empty pattern is valid
// and means "no search filter".
func (v *UserValidator) ValidateSearch(search string) (string, error) {
	if len(strings.TrimSpace(search)) > maxSearchLen {
		return "", errors.NewFieldErrorM(
			"search",
			"too_long",
			messages.M("validator.max_length", "search", maxSearchLen),
		)
	}
	return normalizeSearch(search), nil
}

// ValidatePositiveIDs checks a batch of ids for a param: it must not be empty,
// must not exceed maxBatchIDs entries, and every entry must be a positive id.
func (v *UserValidator) ValidatePositiveIDs(ids []int64, field string) error {
	if len(ids) == 0 {
		return errors.NewFieldErrorM(field, "required", messages.M("validator.required", field))
	}
	if len(ids) > maxBatchIDs {
		return errors.NewValidationErrorM(messages.M("validator.max_values", field, maxBatchIDs))
	}
	for _, id := range ids {
		if err := v.ValidatePositiveID(id, field); err != nil {
			return err
		}
	}
	return nil
}

func (v *UserValidator) ValidateDayRange(start, end date.Date) error {
	if start == "" {
		return errors.NewFieldError("start_date", "required", "start_date is required")
	}
	if end == "" {
		return errors.NewFieldError("end_date", "required", "end_date is required")
	}

	s, e := start.Time(), end.Time()
	if e.Before(s) {
		return errors.NewFieldError(
			"end_date",
			"date_range",
			"end_date must be greater than or equal to start_date",
		)
	}
	if int(e.Sub(s).Hours()/hoursPerDay) > maxDayRange-1 {
		return errors.NewValidationErrorM(messages.M("validator.max_days", maxDayRange))
	}
	return nil
}
