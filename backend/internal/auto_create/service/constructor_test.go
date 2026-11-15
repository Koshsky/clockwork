package service_test

import (
	"context"
	"errors"
	"log/slog"
	"testing"

	"github.com/Koshsky/erp-backend/internal/auto_create/dto"
	"github.com/Koshsky/erp-backend/internal/auto_create/service"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

type configRepository struct {
	service.AutoCreateRepository

	config *dto.AutoCreateConfig
	err    error
	seen   context.Context
}

func (r *configRepository) GetConfig(ctx context.Context) (*dto.AutoCreateConfig, error) {
	r.seen = ctx
	return r.config, r.err
}

func TestConstructorUsesInjectedConfigRepository(t *testing.T) {
	t.Parallel()
	failure := errors.New("config read failed")
	for _, tc := range []struct {
		name      string
		err       error
		cancelled bool
	}{
		{name: "stored config"},
		{name: "repository failure", err: failure},
		{name: "cancelled read", err: context.Canceled, cancelled: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if tc.cancelled {
				cancel()
			}
			repository := &configRepository{err: tc.err}
			if tc.err == nil {
				repository.config = &dto.AutoCreateConfig{Enabled: true, Processes: []dto.ProcessTemplate{}}
			}
			app := service.NewAutoCreateService(slog.New(slog.DiscardHandler), tracing.New(nil), repository)
			config, err := app.GetConfig(ctx)
			if !errors.Is(err, tc.err) || config != repository.config {
				t.Fatalf("injected repository response changed: config=%v err=%v", config, err)
			}
			if repository.seen == nil || !errors.Is(repository.seen.Err(), ctx.Err()) {
				t.Fatal("request cancellation was not preserved")
			}
		})
	}
}
