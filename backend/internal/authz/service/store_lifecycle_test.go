//nolint:testpackage // Verifies that the private TTL loop exits on Stop.
package service

import (
	"log/slog"
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
)

func TestPolicyStoreStopEndsRefreshLoop(t *testing.T) {
	t.Parallel()
	store := NewPolicyStore(slog.New(slog.DiscardHandler), nil, nil, config.Duration(time.Hour))
	done := make(chan struct{})
	go func() {
		store.refreshLoop()
		close(done)
	}()
	store.Stop()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("stopped refresh loop did not exit")
	}
}
