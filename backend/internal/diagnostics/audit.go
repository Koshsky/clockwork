package diagnostics

// Queue identifies one of the existing audit buffers.
type Queue string

const (
	Regular  Queue = "regular"
	Critical Queue = "critical"
)

// Valid restricts queue labels to the two authored buffer names.
func (q Queue) Valid() bool { return q == Regular || q == Critical }

// AuditQueueStatus reports current work and known delivery observations. Pending
// and InFlight can still be delivered after a shutdown caller's deadline.
type AuditQueueStatus struct {
	Queue               Queue  `json:"queue"`
	Pending             uint64 `json:"pending"`
	InFlight            uint64 `json:"in_flight"`
	OldestAgeMS         int64  `json:"oldest_age_ms"`
	Enqueued            uint64 `json:"enqueued"`
	Delivered           uint64 `json:"delivered"`
	Attempts            uint64 `json:"attempts"`
	Retries             uint64 `json:"retries"`
	Overflow            uint64 `json:"overflow"`
	Exhausted           uint64 `json:"exhausted"`
	InlineFailures      uint64 `json:"inline_failures"`
	AfterStop           uint64 `json:"after_stop"`
	LastShutdownPending uint64 `json:"last_shutdown_pending"`
}

// AuditStatus is an in-process safe snapshot, not an audit event or public API.
// Counters cannot reveal losses caused by an abrupt process termination.
type AuditStatus struct {
	Enabled bool                `json:"enabled"`
	Sync    bool                `json:"sync"`
	Stopped bool                `json:"stopped"`
	Queues  [2]AuditQueueStatus `json:"queues"`
}
