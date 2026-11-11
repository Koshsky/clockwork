// Package userctx holds the authenticated user context and accessors to read it
// from the Gin request context.
package userctx

import (
	"errors"
	"slices"

	"github.com/gin-gonic/gin"
)

// PermissionRule is a per-user override of the preset rule for a
// (resource, action) pair: an explicit grant (Granted=true, Scope) or an
// explicit revoke (Granted=false, Scope ignored). A missing rule means the
// user falls back to the assigned preset; admin ignores all rules (bypass).
type PermissionRule struct {
	Resource string `json:"resource"`
	Action   string `json:"action"`
	Scope    string `json:"scope,omitempty"` // all|own|parent|ancestor (when granted)
	Granted  bool   `json:"granted"`
}

// UserContext is the authenticated user carried through the request, with the
// caller's effective rights resolved by the RBAC store (admin bypass, assigned
// preset and per-user overrides).
type UserContext struct {
	ID     int64  `json:"id"`
	Admin  bool   `json:"admin"`
	Preset string `json:"preset,omitempty"`
	// Rules are the caller's individual permission overrides
	// (see PermissionRule); nil — none.
	Rules    []PermissionRule `json:"rules,omitempty"`
	Email    string           `json:"email,omitempty"`
	FullName string           `json:"full_name,omitempty"`
	TenantID int64            `json:"tenant_id,omitempty"`
}

// KeyUser is the Gin context key under which the UserContext is stored.
const KeyUser = "user"

// GetUser extracts the user context from the Gin context.
func GetUser(c *gin.Context) (UserContext, error) {
	val, exists := c.Get(KeyUser)
	if !exists {
		return UserContext{}, errors.New("user not found in context")
	}

	user, ok := val.(UserContext)
	if !ok {
		return UserContext{}, errors.New("invalid user context type")
	}

	return user, nil
}

// MustGetUser panics if the user is not found in the context.
func MustGetUser(c *gin.Context) UserContext {
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
