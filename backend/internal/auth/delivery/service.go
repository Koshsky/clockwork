package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/auth/dto"
)

type AuthService interface {
	Login(ctx context.Context, username, password string) (*dto.SessionResult, error)
	RefreshToken(ctx context.Context, refreshToken string) (*dto.SessionResult, error)
	Logout(ctx context.Context, refreshToken string) error
}
