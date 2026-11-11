package dto

// RefreshRequest is the body accepted by /auth/refresh and /auth/logout. The
// opaque refresh token may be supplied in the request body (for clients that
// cannot use the HttpOnly cookie, e.g. a desktop SPA) as an alternative to the
// cookie transport.
type RefreshRequest struct {
	RefreshToken string `json:"refresh_token" example:"a1b2c3d4..."`
}
