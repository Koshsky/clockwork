//nolint:testpackage // deterministic delivery gates exercise the existing sender worker.
package audit

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
	logpkg "github.com/Koshsky/erp-backend/internal/logger"
)

type gatedAudit struct {
	entered  chan Event
	release  chan struct{}
	mu       sync.Mutex
	calls    int
	failures int
}

func (g *gatedAudit) Send(ctx context.Context, ev Event) error {
	select {
	case g.entered <- ev:
	default:
	}
	select {
	case <-g.release:
	case <-ctx.Done():
		return ctx.Err()
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	g.calls++
	if g.calls <= g.failures {
		return errors.New("canary-loki-secret")
	}
	return nil
}
func waitAudit(t *testing.T, ch <-chan Event) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(3 * time.Second):
		t.Fatal("audit worker did not enter delivery")
	}
}

func TestAuditStatusTracksBothQueueBacklogsOverflowAndShutdownRemainder(t *testing.T) {
	t.Parallel()
	client := &gatedAudit{entered: make(chan Event, 8), release: make(chan struct{})}
	s := newTestSender(client, false)
	defer func() { close(client.release); s.Stop(context.Background()) }()
	started := time.Now()
	s.Enqueue(Event{TS: "1900-canary-time"})
	waitAudit(t, client.entered)
	for range senderQueueCapacity {
		s.Enqueue(Event{TS: "1900-canary-time"})
	}
	s.Enqueue(Event{})
	for range senderCriticalQueueCapacity {
		s.Enqueue(Event{Critical: true})
	}
	s.Enqueue(Event{Critical: true})
	time.Sleep(2 * time.Millisecond)
	status := s.Status()
	regular, critical := status.Queues[0], status.Queues[1]
	if regular.Pending != senderQueueCapacity || regular.InFlight != 1 || regular.Overflow != 1 ||
		critical.Pending != senderCriticalQueueCapacity ||
		critical.Overflow != 1 ||
		s.Dropped() != 2 {
		t.Fatalf("incorrect bounded queue status: %+v", status)
	}
	// A forged payload timestamp must not be used as queue age.
	if regular.OldestAgeMS <= 0 || critical.OldestAgeMS <= 0 ||
		regular.OldestAgeMS > time.Since(started).Milliseconds()+1 ||
		critical.OldestAgeMS > time.Since(started).Milliseconds()+1 {
		t.Fatal("payload timestamp controlled queue age")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	s.Stop(ctx)
	status = s.Status()
	if !status.Stopped || status.Queues[0].LastShutdownPending != senderQueueCapacity+1 ||
		status.Queues[1].LastShutdownPending != senderCriticalQueueCapacity {
		t.Fatal("shutdown pretended queued/in-flight work was delivered")
	}
	s.Enqueue(Event{})
	if s.Status().Queues[0].AfterStop != 1 {
		t.Fatal("post-stop rejection was invisible")
	}
}

func TestAuditRetryCountsAttemptsOnceAndDoesNotInflateDeliveredEvents(t *testing.T) {
	t.Parallel()
	client := &gatedAudit{entered: make(chan Event, 8), release: make(chan struct{}), failures: 2}
	close(client.release)
	s := newTestSender(client, false)
	s.Enqueue(Event{Critical: true})
	s.Stop(context.Background())
	q := s.Status().Queues[1]
	if q.Enqueued != 1 || q.Attempts != 3 || q.Retries != 2 || q.Delivered != 1 || q.Exhausted != 0 ||
		q.InFlight != 0 ||
		q.Pending != 0 {
		t.Fatalf("retry counted as new events: %+v", q)
	}
	// Multiple callers can stop diagnostics without panicking or recounting work.
	s.Stop(context.Background())
}

func TestAuditExhaustionAndInlineFailureRemainBestEffort(t *testing.T) {
	t.Parallel()
	for _, inline := range []bool{false, true} {
		t.Run(map[bool]string{false: "async", true: "inline"}[inline], func(t *testing.T) {
			t.Parallel()
			client := &stubService{err: errors.New("canary-secret")}
			s := newTestSender(client, inline)
			s.Enqueue(Event{})
			s.Stop(context.Background())
			q := s.Status().Queues[0]
			if q.Delivered != 0 || q.InFlight != 0 || q.Enqueued != 1 {
				t.Fatal("failed audit became delivered")
			}
			if inline {
				if q.Attempts != 1 || q.InlineFailures != 1 || q.Exhausted != 0 {
					t.Fatal("inline failure was retried or omitted")
				}
			} else if q.Attempts != 3 || q.Exhausted != 1 || q.Retries != 2 {
				t.Fatal("async exhaustion was omitted")
			}
		})
	}
}

func TestAuditRealLokiFailuresKeepSafeStatusAndLogs(t *testing.T) {
	t.Parallel()
	for _, slow := range []bool{false, true} {
		t.Run(map[bool]string{false: "unavailable", true: "slow"}[slow], func(t *testing.T) {
			t.Parallel()
			var output lockedAuditLog
			logger, err := logpkg.NewWithWriter("debug", "json", &output)
			if err != nil {
				t.Fatal(err)
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				if slow {
					<-r.Context().Done()
					return
				}
				http.Error(w, "canary-loki-password", http.StatusServiceUnavailable)
			}))
			defer server.Close()
			cfg := config.AuditConfig{Enabled: true, URL: server.URL, Timeout: config.Duration(20 * time.Millisecond)}
			s := NewSender(logger, NewClient(logger, cfg, nil), cfg)
			s.Enqueue(Event{Entity: "canary-entity", Path: "/canary-object"})
			s.Stop(context.Background())
			q := s.Status().Queues[0]
			if q.Exhausted != 1 || q.Attempts != 3 || q.Delivered != 0 || q.Retries != 2 {
				t.Fatalf("Loki failure status wrong: %+v", q)
			}
			text := output.text()
			if strings.Contains(text, "canary") || !strings.Contains(text, `"queue":"regular"`) ||
				!strings.Contains(text, `"pending":0`) {
				t.Fatalf("unsafe or incomplete queue diagnostics: %s", text)
			}
		})
	}
}

type lockedAuditLog struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (l *lockedAuditLog) Write(value []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.buffer.Write(value)
}
func (l *lockedAuditLog) text() string { l.mu.Lock(); defer l.mu.Unlock(); return l.buffer.String() }

func TestConcurrentShutdownDoesNotSilentlyAcceptUndeliverableEvents(t *testing.T) {
	t.Parallel()
	s := newTestSender(&stubService{}, false)
	var workers sync.WaitGroup
	workers.Go(func() {
		for i := range 1000 {
			s.Enqueue(Event{Critical: i%2 == 0})
		}
	})
	workers.Go(func() { s.Stop(context.Background()) })
	workers.Wait()
	s.Stop(context.Background())
	status := s.Status()
	var observed uint64
	for _, q := range status.Queues {
		observed += q.Enqueued + q.AfterStop + q.Overflow
		if q.Pending != 0 || q.InFlight != 0 || q.Delivered != q.Enqueued {
			t.Fatalf("shutdown accepted work after its drain: %+v", q)
		}
	}
	if observed != 1000 {
		t.Fatalf("shutdown silently lost observations: %d", observed)
	}
}
