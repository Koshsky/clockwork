package logger

import (
	"fmt"
	"log/slog"
	"os"
	"strings"
)

const (
	FormatText = "text"
	FormatJSON = "json"
)

func New(levelValue, formatValue string) (*slog.Logger, error) {
	level, err := parseLevel(levelValue)
	if err != nil {
		return nil, err
	}

	options := &slog.HandlerOptions{Level: level}

	var handler slog.Handler
	switch normalizeFormat(formatValue) {
	case FormatJSON:
		handler = slog.NewJSONHandler(os.Stdout, options)
	case FormatText:
		handler = slog.NewTextHandler(os.Stdout, options)
	default:
		return nil, fmt.Errorf("unsupported log format: %s", formatValue)
	}

	return slog.New(NewContextHandler(handler)), nil
}

func WithComponent(base *slog.Logger, component string) *slog.Logger {
	if base == nil {
		base = slog.Default()
	}

	return base.With("component", component)
}

func parseLevel(raw string) (slog.Level, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "debug":
		return slog.LevelDebug, nil
	case "info", "":
		return slog.LevelInfo, nil
	case "warn", "warning":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, fmt.Errorf("unsupported log level: %s", raw)
	}
}

func normalizeFormat(raw string) string {
	format := strings.ToLower(strings.TrimSpace(raw))
	if format == "" {
		return FormatText
	}

	return format
}
