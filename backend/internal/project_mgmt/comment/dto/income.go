package dto

type CreateCommentRequest struct {
	Content string `json:"content" example:"Перенести сроки?"`
	// Reply to another comment of the same task; empty means a root comment.
	ParentID *int64 `json:"parent_id" example:"3"`
}
