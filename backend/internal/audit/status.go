package audit

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/Koshsky/erp-backend/internal/diagnostics"
)

type queuedEvent struct {
	event    Event
	sequence uint64
}
type queueTracking struct {
	status  diagnostics.AuditQueueStatus
	pending map[uint64]time.Time
}
type senderStatus struct {
	mu       sync.Mutex
	sequence uint64
	queues   [2]queueTracking
}

func queueIndex(critical bool) int {
	if critical {
		return 1
	}
	return 0
}

func (s *Sender) initializeStatus() {
	s.state.queues[0] = queueTracking{
		status:  diagnostics.AuditQueueStatus{Queue: diagnostics.Regular},
		pending: make(map[uint64]time.Time),
	}
	s.state.queues[1] = queueTracking{
		status:  diagnostics.AuditQueueStatus{Queue: diagnostics.Critical},
		pending: make(map[uint64]time.Time),
	}
}

// Status returns bounded, identity-free counters independently of Prometheus.
// Queue age uses local enqueue time, never the audit payload's timestamp.
func (s *Sender) Status() diagnostics.AuditStatus {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	result := diagnostics.AuditStatus{Enabled: s.enabled, Sync: s.sync, Stopped: s.stopped.Load()}
	for i, q := range s.state.queues {
		result.Queues[i] = q.status
		result.Queues[i].Pending = uint64(len(q.pending))
		var oldest time.Time
		for _, at := range q.pending {
			if oldest.IsZero() || at.Before(oldest) {
				oldest = at
			}
		}
		if !oldest.IsZero() {
			result.Queues[i].OldestAgeMS = max(0, time.Since(oldest).Milliseconds())
		}
	}
	return result
}

func (s *Sender) beginDelivery(ev queuedEvent) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	q := &s.state.queues[queueIndex(ev.event.Critical)]
	delete(q.pending, ev.sequence)
	q.status.InFlight++
}
func (s *Sender) finishDelivery(ev Event, err error, inline bool) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	q := &s.state.queues[queueIndex(ev.Critical)]
	q.status.InFlight--
	switch {
	case err == nil:
		q.status.Delivered++
	case inline:
		q.status.InlineFailures++
	default:
		q.status.Exhausted++
	}
}
func (s *Sender) recordAttempt(ev Event, retry bool) {
	s.state.mu.Lock()
	defer s.state.mu.Unlock()
	q := &s.state.queues[queueIndex(ev.Critical)]
	q.status.Attempts++
	if retry {
		q.status.Retries++
	}
}
func (s *Sender) shutdownPending() {
	s.state.mu.Lock()
	var pending [2]diagnostics.AuditQueueStatus
	for i := range s.state.queues {
		q := &s.state.queues[i]
		q.status.LastShutdownPending = uint64(len(q.pending)) + q.status.InFlight
		pending[i] = q.status
	}
	s.state.mu.Unlock()
	for _, q := range pending {
		s.logger.Warn("audit shutdown pending", "queue", q.Queue, "pending", q.LastShutdownPending)
	}
}

func (s *Sender) logQueue(ctx context.Context, level slog.Level, message string, critical bool, err error) {
	if !s.logger.Enabled(ctx, level) {
		return
	}
	q := s.Status().Queues[queueIndex(critical)]
	attrs := []slog.Attr{
		slog.Any("queue", q.Queue),
		slog.Uint64("pending", q.Pending),
		slog.Uint64("in_flight", q.InFlight),
		slog.Int64("oldest_age_ms", q.OldestAgeMS),
		slog.Int64("dropped_total", s.Dropped()),
	}
	if err != nil {
		attrs = append(attrs, slog.Any("error", err))
	}
	s.logger.LogAttrs(ctx, level, message, attrs...)
}
