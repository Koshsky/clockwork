package audit

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Koshsky/erp-backend/internal/config"
)

// Buffered sender constants.
const (
	// senderQueueCapacity bounds the in-memory event buffer (drop + log when
	// full — audit must never block or fail the user request).
	senderQueueCapacity = 1024
	// senderCriticalQueueCapacity bounds the priority buffer for security
	// events (login/logout). It is drained ahead of the main queue, so the
	// authentication trail survives a backlog of regular mutations; an
	// overflow here is logged and counted like any other drop.
	senderCriticalQueueCapacity = 1024
	// senderMaxAttempts is the retry budget for one event (off the request
	// goroutine only).
	senderMaxAttempts = 3
	// senderBaseBackoff is the initial retry delay (doubled per attempt).
	senderBaseBackoff = 50 * time.Millisecond
	// clientTimeoutForRetry bounds each retry attempt context (the client has
	// its own timeout; this is a safety net for the retry context).
	clientTimeoutForRetry = 5 * time.Second
	// senderSyncSendTimeout is the hard per-request budget of the single
	// synchronous send used with audit.sync: true. An event sent inside the
	// request must never get close to the server request/write timeouts, so
	// the bounded retry loop (3 attempts, seconds each) is not used there (I4).
	senderSyncSendTimeout = time.Second
)

// eventSender ships one event to the audit store (implemented by *Client).
type eventSender interface {
	Send(ctx context.Context, ev Event) error
}

// Sender drains audit events to the auditlog service. In the default async
// mode every event is buffered and retried off the request goroutine; critical
// events (login/logout, M2) enqueue into a priority buffer that is drained
// first. With sync=true each event is sent with one bounded attempt inside the
// request (strict durability, slower, capped by senderSyncSendTimeout).
type Sender struct {
	logger   *slog.Logger
	client   eventSender
	sync     bool
	queue    chan Event
	critical chan Event
	done     chan struct{}
	stopped  atomic.Bool
	dropped  atomic.Int64
	wg       sync.WaitGroup
}

// NewSender builds the sender and, in async mode, starts its worker.
func NewSender(logger *slog.Logger, client *Client, cfg config.AuditConfig) *Sender {
	return newSender(logger, client, cfg.Sync)
}

// newSender builds the sender around the given event sender (test seam).
func newSender(logger *slog.Logger, client eventSender, syncMode bool) *Sender {
	s := &Sender{
		logger: logger.With("component", "audit_sender"),
		client: client,
		sync:   syncMode,
	}
	if !s.sync {
		s.queue = make(chan Event, senderQueueCapacity)
		s.critical = make(chan Event, senderCriticalQueueCapacity)
		s.done = make(chan struct{})
		s.wg.Add(1)
		go s.run()
	}
	return s
}

// Enqueue schedules an event for delivery (async) or sends it with one bounded
// attempt (sync mode). Critical events use the priority buffer so the auth
// trail survives a backlog of regular events (M2). A full buffer drops the
// event with an error log and a running dropped counter; enqueue never blocks
// the request goroutine (I4).
func (s *Sender) Enqueue(ev Event) {
	if s.sync {
		_ = s.sendInline(ev)
		return
	}
	if s.stopped.Load() {
		return
	}
	if ev.Critical {
		s.enqueue(ev, s.critical)
		return
	}
	s.enqueue(ev, s.queue)
}

// enqueue pushes one event into the given buffer non-blocking: a full buffer
// drops the event with an error log and a running counter (audit must never
// block or fail the user request).
func (s *Sender) enqueue(ev Event, queue chan Event) {
	select {
	case queue <- ev:
	default:
		dropped := s.dropped.Add(1)
		s.logger.Error("audit queue full, dropping event",
			"entity", ev.Entity, "action", ev.Action, "path", ev.Path,
			"critical", ev.Critical, "dropped_total", dropped)
	}
}

// Dropped returns how many buffered events were dropped since startup.
func (s *Sender) Dropped() int64 { return s.dropped.Load() }

// Stop signals the worker and waits (bounded by ctx) for the buffer to drain.
func (s *Sender) Stop(ctx context.Context) {
	if s.sync {
		return
	}
	s.stopped.Store(true)
	close(s.done)
	done := make(chan struct{})
	go func() { s.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-ctx.Done():
		s.logger.WarnContext(ctx, "audit sender stop timed out, buffered events may be lost")
	}
}

// run drains the priority and main buffers until Stop. Critical events are
// picked ahead of regular ones so a login/logout trail is never delayed
// behind a batch of mutations (M2).
func (s *Sender) run() {
	defer s.wg.Done()
	for {
		select {
		case ev := <-s.critical:
			s.deliver(ev)
			continue
		default:
		}
		select {
		case ev := <-s.critical:
			s.deliver(ev)
		case ev := <-s.queue:
			s.deliver(ev)
		case <-s.done:
			// Drain the remaining buffered events (best effort, bounded by the
			// client timeout) before exiting.
			s.drain()
			return
		}
	}
}

// drain delivers the events left in both buffers before the worker exits.
func (s *Sender) drain() {
	for {
		select {
		case ev := <-s.critical:
			s.deliver(ev)
		case ev := <-s.queue:
			s.deliver(ev)
		default:
			return
		}
	}
}

// deliver sends one buffered event and logs failures.
func (s *Sender) deliver(ev Event) {
	if err := s.sendWithRetry(ev); err != nil {
		s.logger.Error("audit send failed",
			"error", err, "entity", ev.Entity, "action", ev.Action, "path", ev.Path)
	}
}

// sendWithRetry sends one event with a bounded retry loop. It runs only off
// the request goroutine (the async worker); the synchronous path uses
// sendInline's single bounded attempt instead (I4).
func (s *Sender) sendWithRetry(ev Event) error {
	var lastErr error
	backoff := senderBaseBackoff
	for attempt := 1; attempt <= senderMaxAttempts; attempt++ {
		ctx, cancel := context.WithTimeout(context.Background(), clientTimeoutForRetry)
		err := s.client.Send(ctx, ev)
		cancel()
		if err == nil {
			return nil
		}
		lastErr = err
		if attempt < senderMaxAttempts {
			time.Sleep(backoff)
			backoff *= 2
		}
	}
	return lastErr
}

// sendInline sends one event inside the request (audit.sync: true) with a
// single attempt bounded by senderSyncSendTimeout. In exchange for the strict
// in-request durability the operator opted into, the send stays far below the
// server request/write timeouts, so login never stalls on a down Loki (I4).
func (s *Sender) sendInline(ev Event) error {
	ctx, cancel := context.WithTimeout(context.Background(), senderSyncSendTimeout)
	defer cancel()
	if err := s.client.Send(ctx, ev); err != nil {
		s.logger.Error("audit send failed",
			"error", err, "entity", ev.Entity, "action", ev.Action, "path", ev.Path,
			"critical", ev.Critical)
		return err
	}
	return nil
}
