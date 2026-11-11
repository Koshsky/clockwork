package audit

import "encoding/json"

// maskedValue replaces the value of every sensitive key.
const maskedValue = "***"

// sensitiveKeys are JSON keys whose values are replaced before an event is
// shipped to storage (passwords and token material must not be persisted).
//
//nolint:gochecknoglobals // static masking key set (established pattern)
var sensitiveKeys = map[string]struct{}{
	"password":      {},
	"password_hash": {},
	"old_password":  {},
	"new_password":  {},
	"access_token":  {},
	"refresh_token": {},
	"refresh_hash":  {},
	"token":         {},
	"authorization": {},
}

// MaskJSON redacts sensitive values recursively in a JSON document. Non-JSON
// input is returned unchanged (its structure is unknown, and only JSON bodies
// of logged mutations reach this function).
func MaskJSON(raw []byte) []byte {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return raw
	}
	masked := maskValue(v)
	out, err := json.Marshal(masked)
	if err != nil {
		return raw
	}
	return out
}

// maskValue redacts sensitive keys in maps and slices recursively.
func maskValue(v any) any {
	switch t := v.(type) {
	case map[string]any:
		for k, val := range t {
			if _, ok := sensitiveKeys[k]; ok {
				t[k] = maskedValue
			} else {
				t[k] = maskValue(val)
			}
		}
		return t
	case []any:
		for i, item := range t {
			t[i] = maskValue(item)
		}
		return t
	default:
		return v
	}
}

// extractEntityID pulls the created entity id from a {data:{...}} response
// body (handles the common data.id and data.user.id create shapes).
func extractEntityID(body []byte) *int64 {
	var env struct {
		Data map[string]any `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil || env.Data == nil {
		return nil
	}
	if id := numID(env.Data["id"]); id != nil {
		return id
	}
	if user, ok := env.Data["user"].(map[string]any); ok {
		return numID(user["id"])
	}
	return nil
}

// numID converts a JSON number/float64 in a map to an int64 pointer.
func numID(v any) *int64 {
	f, ok := v.(float64)
	if !ok {
		return nil
	}
	id := int64(f)
	return &id
}

// usernameFromBody extracts the login username (used as the actor label for
// public auth events, where there is no authenticated user yet).
func usernameFromBody(body []byte) string {
	var req struct {
		Username string `json:"username"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return ""
	}
	return req.Username
}
