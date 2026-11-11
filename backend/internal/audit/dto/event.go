// Package dto holds swagger-compatible view types for the audit module.
package dto

// AuditEventView is the swagger model of one audit event row (as returned by
// the auditlog service; the JSON bodies are opaque documents).
type AuditEventView struct {
	ID           int64  `json:"id"                      example:"42"`
	TS           string `json:"ts"                      example:"2026-09-02T10:00:00.000Z"`
	ActorUserID  *int64 `json:"actor_user_id,omitempty" example:"3"`
	ActorName    string `json:"actor_name,omitempty"    example:"Иванов Иван"`
	ActorEmail   string `json:"actor_email,omitempty"   example:"admin@example.ru"`
	ActorRole    string `json:"actor_role,omitempty"    example:"admin"`
	ActorIP      string `json:"actor_ip,omitempty"      example:"172.18.0.1"`
	Entity       string `json:"entity"                  example:"project"`
	Action       string `json:"action"                  example:"create"`
	EntityID     *int64 `json:"entity_id,omitempty"     example:"12"`
	Method       string `json:"method"                  example:"POST"`
	Path         string `json:"path"                    example:"/api/v1/project"`
	Status       int    `json:"status"                  example:"201"`
	DurationMS   *int   `json:"duration_ms,omitempty"   example:"15"`
	RequestBody  any    `json:"request_body,omitempty"`
	ResponseBody any    `json:"response_body,omitempty"`
}
