package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/auto_create/repository/sqlc"
)

type AutoCreateRepository interface {
	GetConfig(ctx context.Context) (*sqlc.GetAutoCreateConfigRow, error)
	UpsertConfig(ctx context.Context, params sqlc.UpsertAutoCreateConfigParams) error
	ExistingResources(ctx context.Context, ids []int64) (map[int64]struct{}, error)
	ExistingUsers(ctx context.Context, ids []int64) (map[int64]struct{}, error)
}
