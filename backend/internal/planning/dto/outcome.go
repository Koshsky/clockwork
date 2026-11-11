package dto

type ProjectPlanning struct {
	Projects []Project `json:"projects"`
}

type ProcessPlanning struct {
	Projects []DetailedProject `json:"projects"`
}

type TaskPlanning struct {
	Processes []DetailedProcess `json:"processes"`
}

type DetailedProject struct {
	Project

	Processes []Process `json:"processes"`
}

type DetailedProcess struct {
	Process

	Tasks      []DetailedTask `json:"tasks"`
	Milestones []Milestone    `json:"milestones"`
	// Scheduling links between the tasks of the process (the successor
	// task_id depends on depends_on_task_id with the given type).
	Dependencies []TaskDependency `json:"dependencies,omitempty"`
}

type DetailedTask struct {
	Task

	Resources []Resource `json:"resources"`
	// Number of active comments on the task (for the badge on the diagram).
	CommentsCount int64 `json:"comments_count" example:"3"`
	// Subtasks (operations) attached to this task, in display order.
	// Present only on top-level tasks; subtasks cannot have subtasks.
	Subtasks []DetailedTask `json:"subtasks,omitempty"`
}
