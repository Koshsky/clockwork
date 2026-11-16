// Package userctx holds the authenticated user context and accessors to read it
// from the Gin request context.
package userctx

import (
	"errors"
	"slices"

	"github.com/gin-gonic/gin"

	access "github.com/Koshsky/erp-backend/internal/authz/domain"
)

// KeyUser is the Gin context key under which the access.UserContext is stored.
const KeyUser = "user"

// GetUser extracts the user context from the Gin context.
func GetUser(c *gin.Context) (access.UserContext, error) {
	val, exists := c.Get(KeyUser)
	if !exists {
		return access.UserContext{}, errors.New("user not found in context")
	}

	user, ok := val.(access.UserContext)
	if !ok {
		return access.UserContext{}, errors.New("invalid user context type")
	}

	return user, nil
}

// MustGetUser panics if the user is not found in the context.
func MustGetUser(c *gin.Context) access.UserContext {
	user, err := GetUser(c)
	if err != nil {
		panic(err)
	}
	return user
}

// GetUserID returns the user ID from the context.
func GetUserID(c *gin.Context) (int64, error) {
	user, err := GetUser(c)
	if err != nil {
		return 0, err
	}
	return user.ID, nil
}

// GetUserPreset returns the user's assigned preset from the context ("" — none).
func GetUserPreset(c *gin.Context) (string, error) {
	user, err := GetUser(c)
	if err != nil {
		return "", err
	}
	return user.Preset, nil
}

// IsAdmin verifies if the user is an admin (the admin preset bypass).
func IsAdmin(c *gin.Context) bool {
	user, err := GetUser(c)
	if err != nil {
		return false
	}
	return user.Admin
}

// HasPreset verifies if the user has any of the allowed presets.
func HasPreset(c *gin.Context, allowedPresets ...string) bool {
	user, err := GetUser(c)
	if err != nil {
		return false
	}

	return slices.Contains(allowedPresets, user.Preset)
}
