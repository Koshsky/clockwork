//nolint:testpackage // tests the unexported Sender internals (same pattern as middleware_test.go)
package audit

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"testing"
	"time"
)

// stubService records delivered events and can fail on demand.
type stubService struct {
	mu       sync.Mutex
	events   []Event
	err      error
	attempts int
}

func (s *stubService) Send(_ context.Context, ev Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.attempts++
	if s.err != nil {
		return s.err
	}
	s.events = append(s.events, ev)
	return nil
}

func (s *stubService) sent() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Event(nil), s.events...)
}

func (s *stubService) callCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.attempts
}

// blockingService never answers until its context is canceled: it proves that
// a synchronous send is bounded by the context deadline.
type blockingService struct{}

func (blockingService) Send(ctx context.Context, _ Event) error {
	<-ctx.Done()
	return ctx.Err()
}

func newTestSender(client eventSender, syncMode bool) *Sender {
	return newSender(slog.New(slog.DiscardHandler), client, syncMode)
}

// stopSender stops the sender with a bounded context: with a failing client
// the drain would otherwise retry every buffered event (tens of seconds).
func stopSender(s *Sender) {
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	s.Stop(ctx)
}

// TestCriticalEventSurvivesFullBuffer checks that a critical event (login) is
// enqueued into the priority buffer even when the main buffer overflowed, and
// that the enqueue returns immediately — critical delivery must never block
// the request goroutine (I4).
func TestCriticalEventSurvivesFullBuffer(t *testing.T) {
	t.Parallel()
	client := &stubService{err: errors.New("loki down")}
	s := newTestSender(client, false)
	defer stopSender(s)

	// Fill the buffer: every buffered event fails after its retry budget, so
	// the worker cannot drain the queue while we enqueue.
	for range senderQueueCapacity + 50 {
		s.Enqueue(Event{Entity: entityUser, Action: "update", Path: "/x"})
	}
	if dropped := s.Dropped(); dropped == 0 {
		t.Fatal("Dropped() = 0, want non-zero after overflowing the buffer")
	}

	// A critical event must not be counted as dropped and must not run the
	// inline retry loop (its minimum cost is one backoff sleep).
	droppedBefore := s.Dropped()
	start := time.Now()
	s.Enqueue(Event{Entity: entityAuth, Action: actionLogin, Path: "/auth/login", Critical: true})
	elapsed := time.Since(start)

	if s.Dropped() != droppedBefore {
		t.Errorf("Dropped() = %d, want %d: the critical event was dropped instead of enqueued",
			s.Dropped(), droppedBefore)
	}
	if elapsed >= senderBaseBackoff {
		t.Errorf("elapsed = %v, want < %v: the critical event blocked the request (inline retry)",
			elapsed, senderBaseBackoff)
	}
}

// TestCriticalEventDeliveredAsync checks that a critical event is delivered by
// the background worker (off the request goroutine) rather than inline.
func TestCriticalEventDeliveredAsync(t *testing.T) {
	t.Parallel()
	client := &stubService{}
	s := newTestSender(client, false)
	defer stopSender(s)

	s.Enqueue(Event{Entity: entityAuth, Action: actionLogin, Path: "/auth/login", Critical: true})

	deadline := time.After(2 * time.Second)
	for {
		for _, ev := range client.sent() {
			if ev.Critical && ev.Action == actionLogin {
				return
			}
		}
		select {
		case <-deadline:
			t.Fatal("critical event was not delivered by the worker")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// TestNonCriticalDropIsCounted checks that a non-critical event dropped by a
// full buffer is counted (M2): with a failing client the worker cannot drain
// the queue, so further buffered events overflow.
func TestNonCriticalDropIsCounted(t *testing.T) {
	t.Parallel()
	client := &stubService{err: errors.New("loki down")}
	s := newTestSender(client, false)
	defer stopSender(s)

	for range senderQueueCapacity + 50 {
		s.Enqueue(Event{Entity: entityUser, Action: "update", Path: "/x"})
	}

	if dropped := s.Dropped(); dropped == 0 {
		t.Fatal("Dropped() = 0, want non-zero after overflowing the buffer")
	}
}

// TestSyncModeSendsInline checks sync mode delivers each event with one inline
// send attempt.
func TestSyncModeSendsInline(t *testing.T) {
	t.Parallel()
	client := &stubService{}
	s := newTestSender(client, true)
	s.Enqueue(Event{Entity: entityAuth, Action: actionLogout, Path: "/auth/logout"})

	sent := client.sent()
	if len(sent) != 1 || sent[0].Action != actionLogout {
		t.Fatalf("sent = %+v, want one logout event", sent)
	}
	if count := client.callCount(); count != 1 {
		t.Fatalf("attempts = %d, want 1 (no inline retry loop)", count)
	}
}

// TestSyncModeSingleAttemptFailsFast checks sync mode makes exactly one
// bounded attempt with a failing client: no retry loop can stall the request
// (I4).
func TestSyncModeSingleAttemptFailsFast(t *testing.T) {
	t.Parallel()
	client := &stubService{err: errors.New("loki down")}
	s := newTestSender(client, true)

	start := time.Now()
	s.Enqueue(Event{Entity: entityAuth, Action: actionLogin, Critical: true})
	elapsed := time.Since(start)

	if count := client.callCount(); count != 1 {
		t.Errorf("attempts = %d, want 1 (no inline retry loop)", count)
	}
	// One instant failure must not even reach the first backoff sleep.
	if elapsed >= senderBaseBackoff {
		t.Errorf("elapsed = %v, want < %v: the sync send outlasted its one-attempt budget", elapsed, senderBaseBackoff)
	}
}

// TestSyncSendBoundedByBudget checks the sync inline send respects the hard
// per-request budget even when the audit store never answers (I4).
func TestSyncSendBoundedByBudget(t *testing.T) {
	t.Parallel()
	s := newTestSender(blockingService{}, true)

	start := time.Now()
	s.Enqueue(Event{Entity: entityAuth, Action: actionLogin, Critical: true})
	elapsed := time.Since(start)

	if elapsed < senderSyncSendTimeout {
		t.Errorf("elapsed = %v, want >= %v (the send must wait for the deadline)", elapsed, senderSyncSendTimeout)
	}
	if elapsed >= 2*senderSyncSendTimeout {
		t.Errorf("elapsed = %v, want < 2*%v (the send must stop at the budget)", elapsed, senderSyncSendTimeout)
	}
}

// TestIsCriticalAction checks the critical set covers auth events only.
func TestIsCriticalAction(t *testing.T) {
	t.Parallel()
	if !isCriticalAction(actionLogin) || !isCriticalAction(actionLogout) {
		t.Error("login/logout must be critical")
	}
	if isCriticalAction("update") || isCriticalAction(actionRefresh) {
		t.Error("non-auth events must not be critical")
	}
}
