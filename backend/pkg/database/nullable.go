// Package nullable provides conversions between nullable database values
// (pgtype.Int8, [sql.NullString]) and idiomatic Go pointer types.
package nullable

import (
	"database/sql"

	"github.com/jackc/pgx/v5/pgtype"
)

// Int64Ptr converts a pgtype.Int8 into an *int64, returning nil when the value is not set.
func Int64Ptr(v pgtype.Int8) *int64 {
	if !v.Valid {
		return nil
	}
	i := v.Int64
	return &i
}

// ToInt8 converts an *int64 into a pgtype.Int8, leaving it unset when v is nil.
func ToInt8(v *int64) pgtype.Int8 {
	if v == nil {
		return pgtype.Int8{}
	}
	return pgtype.Int8{Int64: *v, Valid: true}
}

// PtrValueOr dereferences a pointer, returning fallback when v is nil.
// Useful for passing optional ids through non-nullable query parameters.
func PtrValueOr(v *int64, fallback int64) int64 {
	if v == nil {
		return fallback
	}
	return *v
}

// StringPtr converts a [sql.NullString] into a *string, returning nil when unset/empty.
func StringPtr(v sql.NullString) *string {
	if !v.Valid || v.String == "" {
		return nil
	}
	s := v.String
	return &s
}

// ToString converts a *string into a [sql.NullString], leaving it unset when v is nil.
func ToString(v *string) sql.NullString {
	if v == nil {
		return sql.NullString{}
	}
	return sql.NullString{String: *v, Valid: true}
}
