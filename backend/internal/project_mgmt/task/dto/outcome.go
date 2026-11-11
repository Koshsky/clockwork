package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type TaskResponse struct {
	ID        int64 `json:"id"`
	ProcessID int64 `json:"process_id"`
	// ParentID — subtask (operation) link; NULL for top-level tasks.
	ParentID      *int64  `json:"parent_id"`
	OwnerID       *int64  `json:"owner_id"`
	ResponsibleID *int64  `json:"responsible_id"`
	Title         string  `json:"title"`
	Color         *string `json:"color"`
	// Execution status: not_started | in_progress | done.
	Status    string    `json:"status"`
	StartDate date.Date `json:"start_date"`
	EndDate   date.Date `json:"end_date"`
	// Order of the task within its parent group (ascending display order):
	// top-level tasks sort within the process, subtasks within the parent.
	Order int `json:"order" example:"1"`
}

// ReorderTaskRequest — the complete ordered list of the process's active
// top-level tasks; the server rewrites their order values from the list
// positions. Subtasks keep their positions (they are managed by their parent).
type ReorderTaskRequest struct {
	ProcessID int64   `json:"process_id" example:"1"`
	IDs       []int64 `json:"ids"`
}
