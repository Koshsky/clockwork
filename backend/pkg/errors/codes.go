package errors

import (
	"encoding/json"
	"net/http"

	stderrors "errors"
)

// Code is a machine-readable error code exposed in API responses
// (error.code). All codes live here — the single source of truth.
type Code int

// Error codes. Keep the enum in sync with the String switch below.
const (
	CodeInternal Code = iota
	CodeBadRequest
	CodeUnauthorized
	CodeForbidden
	CodeNotFound
	CodeTooManyRequests
	CodeInvalidCredentials
	CodeInvalidToken
	CodeValidation
	CodeConflict
)

// String returns the wire representation of the code.
func (c Code) String() string {
	switch c {
	case CodeInternal:
		return "INTERNAL_ERROR"
	case CodeBadRequest:
		return "BAD_REQUEST"
	case CodeUnauthorized:
		return "UNAUTHORIZED"
	case CodeForbidden:
		return "FORBIDDEN"
	case CodeNotFound:
		return "NOT_FOUND"
	case CodeTooManyRequests:
		return "TOO_MANY_REQUESTS"
	case CodeInvalidCredentials:
		return "INVALID_CREDENTIALS"
	case CodeInvalidToken:
		return "INVALID_TOKEN"
	case CodeValidation:
		return "VALIDATION_ERROR"
	case CodeConflict:
		return "CONFLICT"
	default:
		return "INTERNAL_ERROR"
	}
}

// MarshalJSON renders the code as its wire string.
func (c Code) MarshalJSON() ([]byte, error) {
	return json.Marshal(c.String())
}

// CodeFor returns the code associated with an HTTP status; used when an error
// does not carry an explicit code.
func CodeFor(status int) Code {
	switch status {
	case http.StatusBadRequest:
		return CodeBadRequest
	case http.StatusUnauthorized:
		return CodeUnauthorized
	case http.StatusForbidden:
		return CodeForbidden
	case http.StatusNotFound:
		return CodeNotFound
	case http.StatusConflict:
		return CodeConflict
	case http.StatusTooManyRequests:
		return CodeTooManyRequests
	default:
		return CodeInternal
	}
}

// coder is implemented by errors that know their machine-readable code.
type coder interface {
	ErrorCode() Code
}

// CodeOf returns the error's code, or CodeFor(status) when it has none.
func CodeOf(err error, status int) Code {
	var c coder
	if stderrors.As(err, &c) {
		return c.ErrorCode()
	}
	return CodeFor(status)
}
