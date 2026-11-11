package dto

type LoginRequest struct {
	Username string `json:"username" example:"ivanov"`
	Password string `json:"password" example:"password"`
}
