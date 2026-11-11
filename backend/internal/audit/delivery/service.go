package delivery

import (
	"context"
	"encoding/json"
	"net/url"
)

// AuditQueryService is the read side of the audit log: it relays the admin
// query to the auditlog service. Plain types keep this package free of an
// import cycle with the root audit package.
type AuditQueryService interface {
	List(ctx context.Context, params url.Values) (json.RawMessage, int64, int, int, error)
}
