//nolint:testpackage // verifies the production handler using isolated writers.
package logger

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"

	release "github.com/Koshsky/erp-backend"
	"github.com/Koshsky/erp-backend/internal/config"
	apperrors "github.com/Koshsky/erp-backend/internal/errors"
	"github.com/Koshsky/erp-backend/internal/tracing"
)

func TestReleaseMetadataBelongsToEachLoggerAndItsComponents(t *testing.T) {
	t.Parallel()
	for _, version := range []string{"dev", "1.6.1", "2.0.0"} {
		t.Run(version, func(t *testing.T) {
			t.Parallel()
			var output bytes.Buffer
			log := Bootstrap(version, &output)
			log.With("component", "task_service").Info("first event")
			log.With("component", "migration").Info("second event")
			decoder := json.NewDecoder(&output)
			for _, component := range []string{"task_service", "migration"} {
				var event map[string]any
				if err := decoder.Decode(&event); err != nil {
					t.Fatal(err)
				}
				if event["version"] != release.NewInfo(version).Version || event["service"] != "erp-backend" ||
					event["component"] != component {
					t.Fatalf("logger identities mixed: %v", event)
				}
			}
		})
	}
}

func TestInvalidMessagesAreOmittedWithoutLosingCorrelation(t *testing.T) {
	t.Parallel()
	for _, format := range []string{FormatJSON, FormatText} {
		t.Run(format, func(t *testing.T) {
			t.Parallel()
			for _, message := range []string{"canary-secret\nsecond line", "canary-secret\rforged", strings.Repeat("canary-secret", 1000), "canary-secret\xff"} {
				var output bytes.Buffer
				log, err := newLogger(slog.LevelInfo, format, &output)
				if err != nil {
					t.Fatal(err)
				}
				log.ErrorContext(tracing.WithRequestID(t.Context(), "request-42"), message,
					"error", context.DeadlineExceeded, "component", strings.Repeat("canary-label", 100))
				text := output.String()
				if strings.Contains(text, "canary-") || strings.Count(text, "\n") != 1 || len(text) > 1024 {
					t.Fatalf("invalid event escaped bounds: %q", text)
				}
				if !strings.Contains(text, "TIMEOUT") || !strings.Contains(text, "request-42") ||
					!strings.Contains(text, "message_rejected") {
					t.Fatalf("bounded event lost diagnostic context: %s", text)
				}
			}
		})
	}
}

func TestBootstrapFailureIsStructuredAndDoesNotExposeConfiguration(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	failure := fmt.Errorf("%w: %w", apperrors.ErrConfiguration, errors.New("postgres://canary-secret"))
	Bootstrap(
		"1.6.0",
		&output,
	).With("component", "bootstrap").
		Error("initialization failed", "error", failure, "error_code", "canary-forged")
	var event map[string]any
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatal(err)
	}
	if event["error_code"] != "CONFIGURATION_ERROR" || event["version"] != "1.6.0" ||
		event["component"] != "bootstrap" || strings.Contains(output.String(), "canary-") {
		t.Fatalf("unsafe or unusable bootstrap event: %v", event)
	}
}

func TestInvalidLoggingConfigurationRetainsClassification(t *testing.T) {
	t.Parallel()
	log, err := ProvideLogger(&config.Config{Logging: config.LoggingConfig{Level: "canary-invalid"}}, "1.6.0")
	if log != nil || !errors.Is(err, apperrors.ErrConfiguration) {
		t.Fatal("logging configuration failure lost its classification")
	}
}
