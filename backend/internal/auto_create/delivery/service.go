package delivery

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
)

type AutoCreateService interface {
	GetConfig(ctx context.Context) (*dto.AutoCreateConfig, error)
	SaveConfig(ctx context.Context, cfg *dto.AutoCreateConfig) error
}
