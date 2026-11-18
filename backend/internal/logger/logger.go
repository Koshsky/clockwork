package logger

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"

	release "github.com/Koshsky/erp-backend"
)

const (
	FormatText = "text"
	FormatJSON = "json"
)

func New(levelValue, formatValue string) (*slog.Logger, error) {
	return NewWithWriter(levelValue, formatValue, os.Stdout)
}

// NewWithWriter keeps tests and embedded consumers on the production privacy boundary.
func NewWithWriter(levelValue, formatValue string, output io.Writer) (*slog.Logger, error) {
	level, err := parseLevel(levelValue)
	if err != nil {
		return nil, err
	}

	return newLogger(level, formatValue, output)
}

func newLogger(level slog.Level, formatValue string, output io.Writer) (*slog.Logger, error) {
	options := &slog.HandlerOptions{Level: level, ReplaceAttr: technicalAttribute}

	var handler slog.Handler
	switch normalizeFormat(formatValue) {
	case FormatJSON:
		handler = slog.NewJSONHandler(output, options)
	case FormatText:
		handler = slog.NewTextHandler(output, options)
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

// WithRelease binds identity before repositories and migrations emit their first logs.
func WithRelease(base *slog.Logger, version string) *slog.Logger {
	return base.With("service", "erp-backend", "version", release.NewInfo(version).Version)
}

// Bootstrap remains available before configuration loading can succeed.
func Bootstrap(version string, output io.Writer) *slog.Logger {
	handler := slog.NewJSONHandler(output, &slog.HandlerOptions{ReplaceAttr: technicalAttribute})
	return WithRelease(slog.New(NewContextHandler(handler)), version)
}
