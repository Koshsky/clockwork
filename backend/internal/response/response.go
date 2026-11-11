package response

import (
	"encoding/json"
	stderrors "errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/Koshsky/erp-backend/internal/middleware/locale"
	"github.com/Koshsky/erp-backend/pkg/errors"
	"github.com/Koshsky/erp-backend/pkg/messages"
)

// Response wraps API responses into { "data": ..., "error": ... } format.
// On success error is an empty object; on failure data is an empty object and
// error carries the domain envelope { code, message, timestamp }.
type Response struct {
	Data  any                 `json:"data"`
	Error *errors.DomainError `json:"error"`
}

// SuccessResponse documents the 2xx envelope for swagger: data carries the
// payload, error is always the empty object {}. Handlers annotate
// response.SuccessResponse{data=...,error=nil} so swag generates error as an
// empty object instead of an untyped field rendered as a plain string.
type SuccessResponse struct {
	Data  any `json:"data"`
	Error any `json:"error"`
}

// ErrorResponse is the swagger model for 4xx/5xx responses: data is empty,
// error carries the domain envelope { code, message, timestamp }.
type ErrorResponse struct {
	Data  any                 `json:"data"`
	Error *errors.DomainError `json:"error"`
}

// MarshalJSON renders empty Data/Error as {} instead of null. The Error field
// keeps its DomainError type so swagger documents the envelope; the runtime
// payload uses an empty object when there is no error.
func (r Response) MarshalJSON() ([]byte, error) {
	data := r.Data
	if data == nil {
		data = map[string]any{}
	}
	var errBody any
	if r.Error != nil {
		errBody = r.Error
	} else {
		errBody = map[string]any{}
	}
	return json.Marshal(struct {
		Data  any `json:"data"`
		Error any `json:"error"`
	}{Data: data, Error: errBody})
}

// internalErrorMessage is the stable client-facing message for 5xx responses.
// It is authored in English and rendered through the catalogs (Russian for RU
// clients); internal details never reach the client, they go to the logs only.
const internalErrorMessage = "internal server error"

// errorBody builds an error envelope with the given code, message and now,
// rendering the message in the request's locale (see messages.Text).
func errorBody(c *gin.Context, code errors.Code, msg string) *errors.DomainError {
	return &errors.DomainError{
		Code:      code,
		Message:   messages.Text(msg, locale.FromGin(c)),
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
}

// renderErrorText resolves the client-facing text of an error for the request
// locale. Parameterized errors (MsgKey set) are re-rendered through the
// catalog with their arguments; every other error falls back to [messages.Text]
// on the carried message text, so an authored RU text resolves to its EN
// catalog entry, an authored EN text to its RU entry, and a missing entry
// degrades to the authored text.
func renderErrorText(err error, l messages.Locale) string {
	var de *errors.DomainError
	if stderrors.As(err, &de) && de.MsgKey != "" {
		return messages.Renderf(de.MsgKey, l, de.MsgArgs...)
	}
	var fe *errors.FieldError
	if stderrors.As(err, &fe) && fe.MsgKey != "" {
		return messages.Renderf(fe.MsgKey, l, fe.MsgArgs...)
	}
	var ve *errors.ValidationError
	if stderrors.As(err, &ve) && ve.MsgKey != "" {
		return messages.Renderf(ve.MsgKey, l, ve.MsgArgs...)
	}
	return messages.Text(err.Error(), l)
}

// OK sends a 200 response with the provided data.
func OK(c *gin.Context, data any) {
	c.JSON(http.StatusOK, Response{Data: data})
}

// Created sends a 201 response with the provided data.
func Created(c *gin.Context, data any) {
	c.JSON(http.StatusCreated, Response{Data: data})
}

// NoContent sends a 204 response with no body.
func NoContent(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

// BadRequest sends a 400 error response. The message is rendered in the
// request's locale.
func BadRequest(c *gin.Context, code errors.Code, msg string) {
	c.JSON(http.StatusBadRequest, Response{Error: errorBody(c, code, msg)})
}

// Unauthorized sends a 401 error response. The message is rendered in the
// request's locale.
func Unauthorized(c *gin.Context, code errors.Code, msg string) {
	c.JSON(http.StatusUnauthorized, Response{Error: errorBody(c, code, msg)})
}

// InternalError sends a 500 error response and logs the internal error. The
// client always receives the generic localized internalErrorMessage; msg and
// err (which may contain internal details) are only written to the logs.
func InternalError(c *gin.Context, logger *slog.Logger, msg string, err error) {
	logger.ErrorContext(c.Request.Context(), msg, "error", err)
	c.JSON(http.StatusInternalServerError, Response{Error: errorBody(c, errors.CodeInternal, internalErrorMessage)})
}

// Forbidden sends a 403 error response. The message is rendered in the
// request's locale.
func Forbidden(c *gin.Context, code errors.Code, msg string) {
	c.JSON(http.StatusForbidden, Response{Error: errorBody(c, code, msg)})
}

// NotFound sends a 404 error response. The message is rendered in the
// request's locale.
func NotFound(c *gin.Context, code errors.Code, msg string) {
	c.JSON(http.StatusNotFound, Response{Error: errorBody(c, code, msg)})
}

// TooManyRequests sends a 429 error response. The message is rendered in the
// request's locale.
func TooManyRequests(c *gin.Context, msg string) {
	c.JSON(http.StatusTooManyRequests, Response{Error: errorBody(c, errors.CodeTooManyRequests, msg)})
}

// Error maps a domain error to an HTTP response using its status and code:
// errors that carry StatusCode/ErrorCode (forbidden → 403/FORBIDDEN,
// not found → 404/NOT_FOUND, validation → 400/VALIDATION_ERROR) are honored,
// otherwise the error is classified by cause. Internal errors (500) are logged.
// For 4xx, DB-origin details (constraint names, trigger messages) carried by
// the error never reach the client — they are written to the server-side logs
// here, at the single choke point every error response passes through. The
// message is rendered in the request's locale.
func Error(c *gin.Context, logger *slog.Logger, err error) {
	status := errors.StatusCode(err)
	code := errors.CodeOf(err, status)
	if status == http.StatusInternalServerError {
		logger.ErrorContext(c.Request.Context(), "internal error", "error", err)
		c.JSON(status, Response{Error: errorBody(c, code, internalErrorMessage)})
		return
	}
	var de *errors.DomainError
	if stderrors.As(err, &de) && de.Details != "" {
		logger.WarnContext(c.Request.Context(), "client error details", "detail", de.Details)
	}
	c.JSON(status, Response{Error: errorBody(c, code, renderErrorText(err, locale.FromGin(c)))})
}
