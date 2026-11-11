package errors

import (
	"net/http"

	"github.com/Koshsky/erp-backend/pkg/messages"
)

// FieldError is a structured validation error carrying the offending field, a
// machine-readable code and a human-readable message. It maps to HTTP 400 and
// wraps ErrValidation so sentinel matching keeps working.
type FieldError struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`

	// MsgKey and MsgArgs back parameterized messages (see NewFieldErrorM); they
	// are never serialized, mirroring DomainError.MsgKey.
	MsgKey  string `json:"-"`
	MsgArgs []any  `json:"-"`
}

// NewFieldError builds a structured validation error.
func NewFieldError(field, code, message string) *FieldError {
	return &FieldError{Field: field, Code: code, Message: message}
}

// NewFieldErrorM builds a field error for a parameterized message: Message
// carries the Russian text rendered at construction time; MsgKey and MsgArgs
// let the response layer re-render the message per request locale.
func NewFieldErrorM(field, code string, m messages.Message) *FieldError {
	return &FieldError{
		Field:   field,
		Code:    code,
		Message: m.Text(messages.Default),
		MsgKey:  m.Key,
		MsgArgs: m.Args,
	}
}

// Error reports the plain message (without the former "validation failed: "
// prefix) so the text resolves through the message catalogs at the response
// layer and the wire message stays clean in either language.
func (e *FieldError) Error() string {
	return e.Message
}

func (e *FieldError) Unwrap() error {
	return ErrValidation
}

func (e *FieldError) StatusCode() int {
	return http.StatusBadRequest
}

func (e *FieldError) ErrorCode() Code {
	return CodeValidation
}

// ValidationError is a validation failure not tied to a single field. It wraps
// ErrValidation so sentinel matching keeps working and carries the message
// text plus — for parameterized messages — the template key and args for
// per-locale re-rendering at the response layer.
type ValidationError struct {
	Message string
	MsgKey  string
	MsgArgs []any
}

// Error reports the plain message (without the former "validation failed: "
// prefix) so the text resolves through the message catalogs at the response
// layer.
func (e *ValidationError) Error() string {
	return e.Message
}

func (e *ValidationError) Unwrap() error {
	return ErrValidation
}

func (e *ValidationError) StatusCode() int {
	return http.StatusBadRequest
}

func (e *ValidationError) ErrorCode() Code {
	return CodeValidation
}

// NewValidationError builds a validation error from a message. The returned
// error's Error() string is the message itself; the previous "validation
// failed: " prefix is gone so the text resolves through the catalogs.
func NewValidationError(message string) error {
	return &ValidationError{Message: message}
}
