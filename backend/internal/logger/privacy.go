package logger

import (
	"log/slog"
	"strings"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

// technicalAttribute is deliberately closed: new fields need a privacy review.
func technicalAttribute(groups []string, attr slog.Attr) slog.Attr {
	if len(groups) != 0 {
		return slog.Attr{}
	}
	if attr.Key == "error" {
		if err, ok := attr.Value.Any().(error); ok {
			return slog.String("error_code", diagnostics.ErrorCode(err))
		}
		return slog.Attr{}
	}
	if technicalValueAllowed(attr) {
		return attr
	}
	return slog.Attr{}
}

func technicalValueAllowed(attr slog.Attr) bool {
	switch attr.Key {
	case slog.TimeKey, slog.LevelKey, slog.MessageKey:
		return true
	case "component", "version", "service", "platform", "request_id", "trace_id", "span_id":
		return attr.Value.Kind() == slog.KindString && safeLabel(attr.Value.String())
	case "method":
		return attr.Value.Kind() == slog.KindString && diagnostics.HTTPMethod(attr.Value.String()) != "OTHER"
	case "route":
		const maxRouteLength = 256
		return attr.Value.Kind() == slog.KindString && len(attr.Value.String()) <= maxRouteLength &&
			strings.HasPrefix(attr.Value.String(), "/") && !strings.ContainsAny(attr.Value.String(), "?\r\n")
	case "status", "duration_ms", "max_conns", "min_conns", "acquired_conns", "total_conns", "dropped_total":
		return attr.Value.Kind() == slog.KindInt64 || attr.Value.Kind() == slog.KindUint64
	case "critical":
		return attr.Value.Kind() == slog.KindBool
	default:
		return false
	}
}

func safeLabel(value string) bool {
	const maxLabelLength = 128
	if value == "" || len(value) > maxLabelLength {
		return false
	}
	for _, r := range value {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._:-", r) {
			continue
		}
		return false
	}
	return true
}

// reservedAttribute prevents metadata from impersonating built-in record fields.
func reservedAttribute(key string) bool {
	return key == slog.TimeKey || key == slog.LevelKey || key == slog.MessageKey
}
