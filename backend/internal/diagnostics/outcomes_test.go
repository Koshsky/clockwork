package diagnostics_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
	"github.com/Koshsky/erp-backend/internal/logger"
)

func TestOutcomeCountersAreConcurrentAndIsolatedWithoutALogger(t *testing.T) {
	t.Parallel()
	counts := diagnostics.NewOutcomes()
	other := diagnostics.NewOutcomes()
	ctx := diagnostics.WithOutcomes(t.Context(), counts)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() {
			for range 100 {
				diagnostics.Record(ctx, nil, diagnostics.Durable, diagnostics.Accepted, nil)
			}
		})
	}
	wg.Wait()
	got := counts.Snapshot()
	if len(got) != 1 || got[0].Total != 800 || len(other.Snapshot()) != 0 {
		t.Fatal("outcome state is unbounded, shared or lossy")
	}
	diagnostics.Record(ctx, nil, diagnostics.Stage("canary-user"), diagnostics.Accepted, nil)
	diagnostics.Record(ctx, nil, diagnostics.Durable, diagnostics.Outcome("canary-token"), nil)
	if counts.Snapshot()[0].Total != 800 {
		t.Fatal("arbitrary labels were counted")
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	bound := diagnostics.WithOutcomes(canceled, counts)
	if !errors.Is(bound.Err(), context.Canceled) {
		t.Fatal("diagnostics replaced cancellation")
	}
}

func TestOutcomeLogsKeepControlledFieldsAndRedactSensitiveValues(t *testing.T) {
	t.Parallel()
	var out bytes.Buffer
	log, err := logger.NewWithWriter("debug", "json", &out)
	if err != nil {
		t.Fatal(err)
	}
	diagnostics.Record(
		t.Context(),
		log,
		diagnostics.Durable,
		diagnostics.Unknown,
		errors.New("canary-password postgres://canary"),
	)
	log.Info(
		"test",
		"stage",
		"canary-stage",
		"outcome",
		diagnostics.Outcome("canary-outcome"),
		"queue",
		diagnostics.Queue("canary-queue"),
	)
	if strings.Contains(out.String(), "canary") {
		t.Fatal("uncontrolled outcome metadata or errors escaped")
	}
	var event map[string]any
	if err = json.NewDecoder(&out).Decode(&event); err != nil {
		t.Fatal(err)
	}
	if event["stage"] != "durable" || event["outcome"] != "unknown" || event["error_code"] != "INTERNAL_ERROR" {
		t.Fatalf("controlled diagnostic fields lost: %v", event)
	}
}

func TestReadFailuresUseControlledOutcomeWithoutChangingErrors(t *testing.T) {
	t.Parallel()
	counts := diagnostics.NewOutcomes()
	ctx := diagnostics.WithOutcomes(t.Context(), counts)
	diagnostics.Failure(ctx, slog.New(slog.DiscardHandler), diagnostics.Planning, nil)
	diagnostics.Failure(ctx, nil, diagnostics.Calendar, errors.New("canary row"))
	if got := counts.Snapshot(); len(got) != 1 || got[0].Stage != diagnostics.Calendar ||
		got[0].Outcome != diagnostics.Failed {
		t.Fatal("read outcome was fabricated or omitted")
	}
}
