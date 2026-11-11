// Package errors is the single taxonomy of domain errors. Errors are
// self-describing: they carry their HTTP status (StatusCode), a machine
// readable code (ErrorCode) and stay compatible with sentinel matching via
// wrapped causes. DomainError doubles as the serialized error envelope
// ({ code, message, timestamp }).
package errors

import (
	"net/http"
	"time"

	stderrors "errors"

	"github.com/Koshsky/erp-backend/pkg/messages"
)

// DomainError is an error that knows its HTTP status, machine-readable code
// and may wrap a cause. It is also the API error body: only Code, Message and
// Timestamp are serialized; Details (DB constraint names, raw server messages)
// never reach the client and are only written to the server-side logs.
type DomainError struct {
	Code      Code   `json:"code"      example:"BAD_REQUEST"          swaggertype:"string"`
	Message   string `json:"message"   example:"Some error message"`
	Timestamp string `json:"timestamp" example:"2026-08-09T10:30:00Z"`

	Status  int    `json:"-"`
	Cause   error  `json:"-"`
	Details string `json:"-"`

	// MsgKey and MsgArgs back parameterized messages (see the M constructors):
	// when MsgKey is set, the response layer re-renders the message per request
	// locale instead of sending the Russian text rendered at construction time.
	// Both fields are never serialized.
	MsgKey  string `json:"-"`
	MsgArgs []any  `json:"-"`
}

func (e *DomainError) Error() string   { return e.Message }
func (e *DomainError) Unwrap() error   { return e.Cause }
func (e *DomainError) StatusCode() int { return e.Status }
func (e *DomainError) ErrorCode() Code { return e.Code }

// Base sentinels used as the Cause of constructed errors so that
// sentinel matching against ErrNotFound and friends keeps working.
var (
	ErrNotFound   = stderrors.New("not found")
	ErrForbidden  = stderrors.New("forbidden")
	ErrBadRequest = stderrors.New("bad request")
	ErrValidation = stderrors.New("validation failed")
	ErrConflict   = stderrors.New("conflict")
)

// now returns the RFC3339 UTC timestamp used in error envelopes.
func now() string {
	return time.Now().UTC().Format(time.RFC3339)
}

// NewValidationErrorM builds a validation error for a parameterized message:
// Message carries the Russian text rendered at construction time; MsgKey and
// MsgArgs let the response layer re-render the message per request locale.
func NewValidationErrorM(m messages.Message) error {
	return &ValidationError{
		Message: m.Text(messages.Default),
		MsgKey:  m.Key,
		MsgArgs: m.Args,
	}
}

// NotFound returns a 404 error wrapping ErrNotFound.
func NotFound(msg string) error {
	return &DomainError{
		Status:    http.StatusNotFound,
		Message:   msg,
		Cause:     ErrNotFound,
		Code:      CodeNotFound,
		Timestamp: now(),
	}
}

// NotFoundM returns a 404 error for a parameterized message (see BadRequestM).
func NotFoundM(m messages.Message) error {
	return &DomainError{
		Status:    http.StatusNotFound,
		Message:   m.Text(messages.Default),
		Cause:     ErrNotFound,
		Code:      CodeNotFound,
		Timestamp: now(),
		MsgKey:    m.Key,
		MsgArgs:   m.Args,
	}
}

// Forbidden returns a 403 error wrapping ErrForbidden.
func Forbidden(msg string) error {
	return &DomainError{
		Status:    http.StatusForbidden,
		Message:   msg,
		Cause:     ErrForbidden,
		Code:      CodeForbidden,
		Timestamp: now(),
	}
}

// ForbiddenM returns a 403 error for a parameterized message (see BadRequestM).
func ForbiddenM(m messages.Message) error {
	return &DomainError{
		Status:    http.StatusForbidden,
		Message:   m.Text(messages.Default),
		Cause:     ErrForbidden,
		Code:      CodeForbidden,
		Timestamp: now(),
		MsgKey:    m.Key,
		MsgArgs:   m.Args,
	}
}

// BadRequest returns a 400 error wrapping ErrBadRequest.
func BadRequest(msg string) error {
	return &DomainError{
		Status:    http.StatusBadRequest,
		Message:   msg,
		Cause:     ErrBadRequest,
		Code:      CodeBadRequest,
		Timestamp: now(),
	}
}

// BadRequestM returns a 400 error for a parameterized message: Message is
// rendered in Russian at construction time (so existing logs and tests keep
// working), while MsgKey/MsgArgs let the response layer re-render the message
// per request locale.
func BadRequestM(m messages.Message) error {
	return &DomainError{
		Status:    http.StatusBadRequest,
		Message:   m.Text(messages.Default),
		Cause:     ErrBadRequest,
		Code:      CodeBadRequest,
		Timestamp: now(),
		MsgKey:    m.Key,
		MsgArgs:   m.Args,
	}
}

// Conflict returns a 409 error wrapping ErrConflict; used when a create
// collides with an already-existing unique business key (e.g. project code).
func Conflict(msg string) error {
	return &DomainError{
		Status:    http.StatusConflict,
		Message:   msg,
		Cause:     ErrConflict,
		Code:      CodeConflict,
		Timestamp: now(),
	}
}

// ConflictM returns a 409 error for a parameterized message (see BadRequestM).
func ConflictM(m messages.Message) error {
	return &DomainError{
		Status:    http.StatusConflict,
		Message:   m.Text(messages.Default),
		Cause:     ErrConflict,
		Code:      CodeConflict,
		Timestamp: now(),
		MsgKey:    m.Key,
		MsgArgs:   m.Args,
	}
}

// Entity-specific not-found errors for stable sentinel matching in services.
var (
	ErrProjectNotFound    = NotFound("project not found")
	ErrProcessNotFound    = NotFound("process not found")
	ErrMilestoneNotFound  = NotFound("milestone not found")
	ErrTaskNotFound       = NotFound("task not found")
	ErrResourceNotFound   = NotFound("resource not found")
	ErrAssignmentNotFound = NotFound("assignment not found")
	ErrUserNotFound       = NotFound("user not found")
	ErrStateNotFound      = NotFound("state not found")
	ErrCommentNotFound    = NotFound("comment not found")
)

// withDetail attaches an internal diagnostic detail (e.g. a DB constraint
// name or a trigger message) to a domain error. The detail is kept out of the
// response body and is only surfaced to the server-side logs.
func withDetail(err error, detail string) error {
	if de, ok := stderrors.AsType[*DomainError](err); ok {
		de.Details = detail
	}
	return err
}
