package dto

// AutoCreateConfig — configuration for auto-creating processes/tasks when a
// project is inserted. Used both as a request (PUT) and as a response (GET).
type AutoCreateConfig struct {
	Enabled   bool              `json:"enabled"`
	Processes []ProcessTemplate `json:"processes"`
}

type ProcessTemplate struct {
	Title   string         `json:"title"    example:"Инсталляция"`
	OwnerID *int64         `json:"owner_id" example:"5"`
	Color   *string        `json:"color"    example:"#0f83c4"`
	Tasks   []TaskTemplate `json:"tasks"`
}

type TaskTemplate struct {
	Title     string            `json:"title"     example:"Пуско-наладочные работы"`
	Color     *string           `json:"color"     example:"#0f83c4"`
	Resources []ResourceBinding `json:"resources"`
	// Operations (subtasks) of the task — created as subtasks (parent_id)
	// with the task's dates. Status is always not_started; resources are not
	// bound to subtasks.
	Operations []OperationTemplate `json:"operations"`
}

// OperationTemplate — a subtask (operation) of a template task. Only the
// title is configurable; the subtask inherits the parent task's dates.
type OperationTemplate struct {
	Title string `json:"title" example:"Подготовка площадки"`
}

type ResourceBinding struct {
	ResourceID int64 `json:"resource_id"`
	Quantity   int   `json:"quantity"`
}
