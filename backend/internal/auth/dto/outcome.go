package dto

// AuthResponse is the login/refresh payload. The refresh token is returned
// here (alongside the HttpOnly cookie) so clients that cannot read the cookie
// — e.g. a desktop SPA — can persist it in non-volatile storage.
type AuthResponse struct {
	AccessToken  string   `json:"access_token"            example:"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."`
	TokenType    string   `json:"token_type"              example:"Bearer"`
	ExpiresIn    int      `json:"expires_in"              example:"900"`
	RefreshToken string   `json:"refresh_token,omitempty" example:"a1b2c3d4..."`
	User         UserInfo `json:"user"`
}

// SessionResult is what the auth service returns to the delivery layer:
// the response body plus the opaque refresh token for the HttpOnly cookie.
type SessionResult struct {
	Auth         *AuthResponse
	RefreshToken string
}

type UserInfo struct {
	ID         int64   `json:"id"          example:"1"`
	Name       string  `json:"name"        example:"Иванов Иван Иванович"`
	LastName   string  `json:"last_name"   example:"Иванов"`
	FirstName  string  `json:"first_name"  example:"Иван"`
	MiddleName *string `json:"middle_name" example:"Иванович"`
	Username   string  `json:"username"    example:"ivanov"`
	Preset     *string `json:"preset"      example:"rp"`
}
