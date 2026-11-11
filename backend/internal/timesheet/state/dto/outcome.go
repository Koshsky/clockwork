package dto

type StateResponse struct {
	ID          int64   `json:"id"           example:"4"`
	Code        string  `json:"code"         example:"ОТП"`
	Name        string  `json:"name"         example:"Отпуск"`
	IsAvailable bool    `json:"is_available" example:"false"`
	Color       *string `json:"color"        example:"#ffd6a5"`
}
