package delivery

import (
	"log/slog"
	"net/http"
	"strings"
	"time"

	authservice "github.com/Koshsky/erp-backend/internal/auth/service"
	"github.com/Koshsky/erp-backend/internal/config"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/auth/dto"
	"github.com/Koshsky/erp-backend/internal/response"
)

// refreshCookieName — the HttpOnly cookie holding the opaque refresh token (AD-05).
const refreshCookieName = "mvs_refresh"

// refreshCookiePath restricts sending the cookie to auth endpoints only.
const refreshCookiePath = "/api/v1/auth"

type AuthHandler struct {
	service AuthService
	logger  *slog.Logger
	cfg     config.JWTConfig
}

// NewAuthHandler builds the auth handler.
func NewAuthHandler(logger *slog.Logger, svc *authservice.AuthService, cfg config.JWTConfig) *AuthHandler {
	return &AuthHandler{
		logger:  logger.With("component", "auth_handler"),
		service: svc,
		cfg:     cfg,
	}
}

// isHTTPS reports whether the request came over real https: direct TLS or
// X-Forwarded-Proto/Scheme from the reverse proxy (nginx on /api/ sets
// X-Forwarded-Proto $scheme, overwriting the client header).
func isHTTPS(c *gin.Context) bool {
	if c.Request.TLS != nil {
		return true
	}
	proto := c.GetHeader("X-Forwarded-Proto")
	if proto == "" {
		proto = c.GetHeader("X-Forwarded-Scheme")
	}
	return strings.EqualFold(proto, "https")
}

// setRefreshCookie sets the HttpOnly/SameSite=Strict refresh cookie. The Secure
// flag is applied only behind real https (cfg.RefreshCookieSecure — the "strict
// https requirement"): over http the browser will not persist a Secure cookie,
// /auth/refresh becomes unavailable and the web version keeps failing with
// "Session expired".
//
//nolint:gosec // Secure is driven by refresh_cookie_secure + the actual protocol
func (h *AuthHandler) setRefreshCookie(c *gin.Context, token string) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     refreshCookieName,
		Value:    token,
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   h.cfg.RefreshCookieSecure && isHTTPS(c),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(time.Duration(h.cfg.RefreshExpiry).Seconds()),
	})
}

// clearRefreshCookie removes the refresh cookie (logout). Secure must match
// how the cookie was set (the browser identifies a cookie by its attributes).
//
//nolint:gosec // Secure likewise from refresh_cookie_secure; the other flags are static.
func (h *AuthHandler) clearRefreshCookie(c *gin.Context) {
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     refreshCookiePath,
		HttpOnly: true,
		Secure:   h.cfg.RefreshCookieSecure && isHTTPS(c),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   -1,
	})
}

// Login handles the login request.
//
//	@Tags			Auth
//	@Summary		Login
//	@Description	Authenticate user; the refresh token is returned both in the response body and in an HttpOnly cookie
//	@Accept			json
//	@Produce		json
//	@Param			request	body		dto.LoginRequest	true	"Login credentials"
//	@Success		200		{object}	response.SuccessResponse{data=dto.AuthResponse,error=nil}
//	@Failure		400		{object}	response.ErrorResponse{data=nil}
//	@Failure		401		{object}	response.ErrorResponse{data=nil}
//	@Router			/auth/login [post]
func (h *AuthHandler) Login(c *gin.Context) {
	var req dto.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, errors.CodeBadRequest, "invalid request")
		return
	}

	res, err := h.service.Login(c.Request.Context(), req.Username, req.Password)
	if err != nil {
		response.Unauthorized(c, errors.CodeInvalidCredentials, "invalid credentials")
		return
	}

	// Return the refresh token in the body too, so clients that cannot read
	// the HttpOnly cookie (e.g. a desktop SPA) can persist it themselves.
	res.Auth.RefreshToken = res.RefreshToken

	h.setRefreshCookie(c, res.RefreshToken)
	response.OK(c, res.Auth)
}

// RefreshToken handles the request to refresh access token. The refresh token
// may arrive in the request body ({refresh_token}) or, as a fallback, in the
// HttpOnly cookie.
//
//	@Tags			Auth
//	@Summary		Refresh Token
//	@Description	Rotate the refresh session; the token is read from the body ({refresh_token}) or the HttpOnly cookie, and a new refresh token is returned in both
//	@Accept			json
//	@Produce		json
//	@Param			request	body		dto.RefreshRequest	false	"Refresh token (optional; falls back to the HttpOnly cookie)"
//	@Success		200		{object}	response.SuccessResponse{data=dto.AuthResponse,error=nil}
//	@Failure		401		{object}	response.ErrorResponse{data=nil}
//	@Router			/auth/refresh [post]
func (h *AuthHandler) RefreshToken(c *gin.Context) {
	var req dto.RefreshRequest
	// An invalid or empty body is not an error: the cookie is the fallback.
	_ = c.ShouldBindJSON(&req)

	token := req.RefreshToken
	if token == "" {
		if cookie, err := c.Cookie(refreshCookieName); err == nil && cookie != "" {
			token = cookie
		}
	}
	if token == "" {
		response.Unauthorized(c, errors.CodeInvalidToken, "invalid refresh token")
		return
	}

	res, err := h.service.RefreshToken(c.Request.Context(), token)
	if err != nil {
		response.Unauthorized(c, errors.CodeInvalidToken, "invalid refresh token")
		return
	}

	// Return the rotated refresh token in the body too, mirroring login.
	res.Auth.RefreshToken = res.RefreshToken

	h.setRefreshCookie(c, res.RefreshToken)
	response.OK(c, res.Auth)
}

// Logout revokes the refresh session and clears the cookie. The refresh token
// is read from the body ({refresh_token}) or, as a fallback, from the cookie.
//
//	@Tags			Auth
//	@Summary		Logout
//	@Description	Revoke the refresh session and clear the cookie; the token is read from the body ({refresh_token}) or the HttpOnly cookie (idempotent)
//	@Accept			json
//	@Produce		json
//	@Param			request	body		dto.RefreshRequest	false	"Refresh token (optional; falls back to the HttpOnly cookie)"
//	@Success		200		{object}	response.SuccessResponse{data=map[string]string,error=nil}
//	@Router			/auth/logout [post]
func (h *AuthHandler) Logout(c *gin.Context) {
	var req dto.RefreshRequest
	_ = c.ShouldBindJSON(&req)

	token := req.RefreshToken
	if token == "" {
		if cookie, err := c.Cookie(refreshCookieName); err == nil && cookie != "" {
			token = cookie
		}
	}
	if token != "" {
		_ = h.service.Logout(c.Request.Context(), token)
	}
	h.clearRefreshCookie(c)
	response.OK(c, map[string]string{"message": "logged out"})
}
