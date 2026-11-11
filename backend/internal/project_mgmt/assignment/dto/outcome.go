package dto

type AssignmentResponse struct {
	ID         int64 `json:"id"          example:"1"`
	TaskID     int64 `json:"task_id"     example:"1"`
	ResourceID int64 `json:"resource_id" example:"1"`
	Quantity   int   `json:"quantity"    example:"10"`
}
