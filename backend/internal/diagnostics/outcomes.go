package diagnostics

import (
	"context"
	"log/slog"
	"sync/atomic"
)

// Stage identifies a fixed diagnostic boundary, never an entity or request.
type Stage string

const (
	Durable   Stage = "durable"
	Legacy    Stage = "legacy"
	Receipt   Stage = "receipt"
	Revision  Stage = "revision"
	Rollback  Stage = "rollback"
	Migration Stage = "migration"
	RBAC      Stage = "rbac"
	Planning  Stage = "planning"
	Calendar  Stage = "calendar"
)

// Outcome is a controlled observation, not a client acknowledgement guarantee.
type Outcome string

const (
	Accepted   Outcome = "accepted"
	Replayed   Outcome = "replayed"
	Confirmed  Outcome = "confirmed"
	InProgress Outcome = "in_progress"
	NotFound   Outcome = "not_found"
	Conflict   Outcome = "conflict"
	Rejected   Outcome = "rejected"
	Unknown    Outcome = "unknown"
	RolledBack Outcome = "rolled_back"
	Failed     Outcome = "failed"
	Ready      Outcome = "ready"
	Canceled   Outcome = "canceled"
)

func stages() [stageCount]Stage {
	return [stageCount]Stage{Durable, Legacy, Receipt, Revision, Rollback, Migration, RBAC, Planning, Calendar}
}
func outcomes() [outcomeCount]Outcome {
	return [outcomeCount]Outcome{
		Accepted,
		Replayed,
		Confirmed,
		InProgress,
		NotFound,
		Conflict,
		Rejected,
		Unknown,
		RolledBack,
		Failed,
		Ready,
		Canceled,
	}
}

// Valid restricts log and metric labels to the authored vocabulary.
func (s Stage) Valid() bool {
	for _, v := range stages() {
		if v == s {
			return true
		}
	}
	return false
}

// Valid rejects arbitrary strings even after an explicit type conversion.
func (o Outcome) Valid() bool {
	for _, v := range outcomes() {
		if v == o {
			return true
		}
	}
	return false
}

const stageCount = 9
const outcomeCount = 12

// Outcomes keeps bounded process-local counts independently of logging/export.
type Outcomes struct {
	counts [stageCount][outcomeCount]atomic.Uint64
}

// Count is a safe aggregate; it contains no business, user or operation IDs.
type Count struct {
	Stage   Stage   `json:"stage"`
	Outcome Outcome `json:"outcome"`
	Total   uint64  `json:"total"`
}

// NewOutcomes constructs isolated counters with no workers or external storage.
func NewOutcomes() *Outcomes { return &Outcomes{} }

type outcomesKey struct{}

// WithOutcomes attaches the application's counters without replacing cancellation.
func WithOutcomes(ctx context.Context, counts *Outcomes) context.Context {
	if counts == nil || ctx.Value(outcomesKey{}) == counts {
		return ctx
	}
	return context.WithValue(ctx, outcomesKey{}, counts)
}

// Snapshot returns only observed, bounded aggregate outcomes.
func (o *Outcomes) Snapshot() []Count {
	if o == nil {
		return nil
	}
	result := make([]Count, 0)
	for i, stage := range stages() {
		for j, outcome := range outcomes() {
			if n := o.counts[i][j].Load(); n > 0 {
				result = append(result, Count{Stage: stage, Outcome: outcome, Total: n})
			}
		}
	}
	return result
}

func (o *Outcomes) add(stage Stage, outcome Outcome) {
	for i, s := range stages() {
		if stage == s {
			for j, v := range outcomes() {
				if outcome == v {
					o.counts[i][j].Add(1)
					return
				}
			}
		}
	}
}

// Record observes one boundary result. A failed log sink cannot remove counts.
func Record(ctx context.Context, logger *slog.Logger, stage Stage, outcome Outcome, err error) {
	if !stage.Valid() || !outcome.Valid() {
		return
	}
	if counts, ok := ctx.Value(outcomesKey{}).(*Outcomes); ok && counts != nil {
		counts.add(stage, outcome)
	}
	if logger == nil {
		return
	}
	level := slog.LevelInfo
	if outcome == Unknown || outcome == Failed {
		level = slog.LevelWarn
	}
	attrs := []slog.Attr{slog.Any("stage", stage), slog.Any("outcome", outcome)}
	if err != nil {
		attrs = append(attrs, slog.Any("error", err))
	}
	logger.LogAttrs(ctx, level, "diagnostic outcome", attrs...)
}

// Failure records read/validation failures without changing the returned error.
func Failure(ctx context.Context, logger *slog.Logger, stage Stage, err error) {
	if err == nil {
		return
	}
	outcome := Failed
	switch ErrorCode(err) {
	case "FORBIDDEN", "UNAUTHORIZED", "BAD_REQUEST":
		outcome = Rejected
	case "CONFLICT":
		outcome = Conflict
	case "CANCELLED":
		outcome = Canceled
	}
	Record(ctx, logger, stage, outcome, err)
}
