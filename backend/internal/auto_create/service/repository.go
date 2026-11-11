package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
)

type AutoCreateRepository interface {
	GetConfig(ctx context.Context) (*dto.AutoCreateConfig, error)
	UpsertConfig(ctx context.Context, cfg *dto.AutoCreateConfig) error
	ExistingResources(ctx context.Context, ids []int64) (map[int64]struct{}, error)
	ExistingUsers(ctx context.Context, ids []int64) (map[int64]struct{}, error)
}
