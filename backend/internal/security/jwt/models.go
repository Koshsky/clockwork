package jwt

import (
	"github.com/golang-jwt/jwt/v5"
)

type Claims struct {
	jwt.RegisteredClaims

	// UserID identifies the authenticated user; the effective rights (admin
	// bypass, assigned preset, per-user overrides) are resolved per request
	// from the in-memory RBAC snapshot (never from the token, so permission
	// changes apply immediately).
	UserID int64  `json:"user_id"`
	Email  string `json:"email"`
}
