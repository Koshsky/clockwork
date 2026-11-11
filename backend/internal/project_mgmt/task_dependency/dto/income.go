package dto

// CreateDependencyRequest — a new scheduling link: the task in the URL path
// (task_id) depends on depends_on_task_id with the given link type.
type CreateDependencyRequest struct {
	DependsOnTaskID int64  `json:"depends_on_task_id" example:"10"`
	Type            string `json:"type"               example:"fs" enums:"fs,ss,ff,sf"`
}

// UpdateDependencyRequest — a new link type for an existing edge.
type UpdateDependencyRequest struct {
	Type string `json:"type" example:"ss" enums:"fs,ss,ff,sf"`
}
