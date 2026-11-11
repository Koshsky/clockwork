package dto

type CreateResourceRequest struct {
	Code    string  `json:"code"     example:"М"`
	Title   string  `json:"title"    example:"Монтажник"`
	Color   *string `json:"color"    example:"#0f83c4"`
	OwnerID *int64  `json:"owner_id" example:"3"`
}

type UpdateResourceRequest struct {
	Code    *string `json:"code"     example:"М"`
	Title   *string `json:"title"    example:"Монтажник"`
	Color   *string `json:"color"    example:"#0f83c4"`
	OwnerID *int64  `json:"owner_id" example:"3"`
}

type AddMemberRequest struct {
	UserID int64 `json:"user_id" example:"7"`
}
