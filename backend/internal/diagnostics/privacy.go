// Package diagnostics defines the content allowed in technical diagnostics.
package diagnostics

import (
	"context"
	"errors"
	"strings"
	"unicode"

	"github.com/jackc/pgx/v5/pgconn"

	apierrors "github.com/Koshsky/erp-backend/pkg/errors"
)

// ErrorCode never formats an error, whose text may contain credentials or row values.
func ErrorCode(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, context.Canceled):
		return "CANCELLED"
	case errors.Is(err, context.DeadlineExceeded):
		return "TIMEOUT"
	}
	if _, ok := errors.AsType[*pgconn.PgError](err); ok {
		return "DATABASE_ERROR"
	}
	return apierrors.CodeOf(err, apierrors.StatusCode(err)).String()
}

// SecretKey normalizes spelling without treating business fields as diagnostics.
func SecretKey(key string) bool {
	key = strings.Map(func(r rune) rune {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return -1
		}
		return unicode.ToLower(r)
	}, key)
	if strings.Contains(key, "password") {
		return true
	}
	switch key {
	case "password", "passwordhash", "oldpassword", "newpassword", "confirmpassword",
		"databasepassword", "accesstoken", "refreshtoken", "refreshhash", "refreshtokenhash",
		"access", "refresh", "bearertoken", "sessiontoken", "token", "authorization", "cookie", "setcookie", "apikey", "clientsecret",
		"jwtsecret", "jwtrefresh", "jwtsecretkey", "jwtrefreshkey", "privatekey",
		"databaseurl", "databaseuri", "dsn", "connectionstring", "credentials":
		return true
	default:
		return false
	}
}

// HTTPMethod bounds client-controlled method names to a fixed vocabulary.
func HTTPMethod(value string) string {
	switch value {
	case "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS":
		return value
	default:
		return "OTHER"
	}
}
