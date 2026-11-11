package dto

import "time"

type CommentResponse struct {
	ID        int64     `json:"id"         example:"1"`
	TaskID    int64     `json:"task_id"    example:"42"`
	AuthorID  int64     `json:"author_id"  example:"7"`
	ParentID  *int64    `json:"parent_id"  example:"3"`
	Content   string    `json:"content"    example:"Перенести сроки?"`
	CreatedAt time.Time `json:"created_at" example:"2026-02-01T10:00:00Z" format:"date-time"`
}
