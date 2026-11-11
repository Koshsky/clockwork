package logger

import (
	"log/slog"

	"github.com/Koshsky/erp-backend/internal/config"
)

// ProvideLogger builds the application logger from the config.
func ProvideLogger(cfg *config.Config) (*slog.Logger, error) {
	return New(cfg.Logging.Level, cfg.Logging.Format)
}
