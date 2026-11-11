package jwt

import (
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
)

// ProvideJWTService builds the JWT service.
//
// refreshKey (JWT_REFRESH_KEY) is no longer used: refresh tokens are opaque and
// stored in the DB (AD-06); the key is kept in config/env for compatibility.
func ProvideJWTService(cfg config.JWTConfig) *Service {
	return &Service{
		secretKey:     []byte(cfg.SecretKey),
		accessExpiry:  time.Duration(cfg.AccessExpiry),
		refreshExpiry: time.Duration(cfg.RefreshExpiry),
		issuer:        cfg.Issuer,
	}
}
