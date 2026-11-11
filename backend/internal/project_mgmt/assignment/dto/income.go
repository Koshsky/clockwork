package dto

type UpdateAssignmentRequest struct {
	TaskID     *int64 `json:"task_id"     example:"1"`
	ResourceID *int64 `json:"resource_id" example:"1"`
	Quantity   *int   `json:"quantity"    example:"10"`
}

type CreateAssignmentRequest struct {
	TaskID     int64 `json:"task_id"     example:"1"`
	ResourceID int64 `json:"resource_id" example:"1"`
	Quantity   int   `json:"quantity"    example:"5"`
}
