package domain

// Execution status catalog (fixed, 3 states — see the tasks.status CHECK).
const (
	StatusNotStarted = "not_started"
	StatusInProgress = "in_progress"
	StatusDone       = "done"
)
