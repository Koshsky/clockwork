package dto

import "github.com/Koshsky/erp-backend/pkg/date"

type Project struct {
	ID            int64     `json:"id"             example:"1"`
	Code          string    `json:"project_code"   example:"КО_001"`
	Color         *string   `json:"color"          example:"#0f83c4"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01" format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01" format:"date"`
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
	Priority      int       `json:"priority"       example:"2"`
}

type Process struct {
	ProjectOwnerID *int64 `json:"project_owner_id" example:"1"`

	ID            int64     `json:"id"             example:"1"`
	Title         string    `json:"title"          example:"Инсталляция"`
	Color         *string   `json:"color"          example:"#0f83c4"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01"  format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01"  format:"date"`
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
	ProjectID     int64     `json:"project_id"     example:"1"`
	ProjectCode   string    `json:"project_code"   example:"КО_001"`
	// Order of the process within its project (ascending display order).
	Order int `json:"order" example:"1"`
}

type Task struct {
	ID    int64   `json:"id"    example:"1"`
	Title string  `json:"title" example:"Пуско-наладочные работы"`
	Color *string `json:"color" example:"#0f83c4"`
	// ParentID — subtask (operation) link; NULL for top-level tasks.
	ParentID *int64 `json:"parent_id"`
	// Execution status: not_started | in_progress | done.
	Status        string    `json:"status"         example:"not_started"`
	StartDate     date.Date `json:"start_date"     example:"2026-01-01"  format:"date"`
	EndDate       date.Date `json:"end_date"       example:"2026-02-01"  format:"date"`
	ProcessID     int64     `json:"process_id"     example:"1"`
	OwnerID       *int64    `json:"owner_id"       example:"1"`
	ResponsibleID *int64    `json:"responsible_id" example:"2"`
	// Order of the task within its parent group (ascending display order):
	// top-level tasks sort within the process, subtasks within the parent.
	Order int `json:"order" example:"1"`
}

type Resource struct {
	ID           int64   `json:"id"            example:"1"`
	Title        string  `json:"title"         example:"Монтажник"`
	Code         string  `json:"code"          example:"М"`
	Color        *string `json:"color"         example:"#0f83c4"`
	Quantity     int     `json:"quantity"      example:"7"`
	AssignmentID int64   `json:"assignment_id" example:"1"`
}

type Milestone struct {
	ID        int64     `json:"id"         example:"1"`
	Title     string    `json:"title"      example:"Начало работ"`
	Content   string    `json:"content"    example:"Начало работ по проекту"`
	Color     *string   `json:"color"      example:"#0f83c4"`
	Date      date.Date `json:"date"       example:"2026-01-01"              format:"date"`
	ProcessID int64     `json:"process_id" example:"1"`
}

type Assignment struct {
	ID         int64 `json:"id"          example:"1"`
	TaskID     int64 `json:"task_id"     example:"1"`
	ResourceID int64 `json:"resource_id" example:"1"`
	Quantity   int   `json:"quantity"    example:"1"`
}

// TaskDependency — a scheduling link between two top-level tasks of the same
// process: the successor (task_id) must not start/finish before the
// predecessor (depends_on_task_id), per the type (fs/ss/ff/sf).
type TaskDependency struct {
	ID              int64  `json:"id"                 example:"1"`
	TaskID          int64  `json:"task_id"            example:"42"`
	DependsOnTaskID int64  `json:"depends_on_task_id" example:"10"`
	Type            string `json:"type"               example:"fs"`
}
