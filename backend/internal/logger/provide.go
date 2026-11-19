package logger

import (
	"fmt"
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/config"
	apperrors "github.com/Koshsky/erp-backend/internal/errors"
)

// ProvideLogger builds the application logger from the config.
func ProvideLogger(cfg *config.Config, version string) (*slog.Logger, error) {
	log, err := New(cfg.Logging.Level, cfg.Logging.Format)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", apperrors.ErrConfiguration, err)
	}
	return WithRelease(log, version), nil
}
