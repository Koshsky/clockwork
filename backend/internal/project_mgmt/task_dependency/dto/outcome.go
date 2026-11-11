package dto

// DependencyResponse — a scheduling link between two tasks.
type DependencyResponse struct {
	ID int64 `json:"id" example:"1"`
	// Dependent task (successor) of the link.
	TaskID int64 `json:"task_id" example:"42"`
	// Predecessor task of the link.
	DependsOnTaskID int64 `json:"depends_on_task_id" example:"10"`
	// Dependency type: fs | ss | ff | sf.
	Type string `json:"type" example:"fs"`
}
