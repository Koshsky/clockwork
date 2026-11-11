package rbac

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/gin-gonic/gin"

	tracingpkg "github.com/Koshsky/erp-backend/internal/tracing"
	userctx "github.com/Koshsky/erp-backend/internal/userctx"
	"github.com/Koshsky/erp-backend/pkg/errors"

	"github.com/Koshsky/erp-backend/internal/response"
)

// ResolveByID returns the owner chain of an entity by its id.
type ResolveByID func(ctx context.Context, id int64) (Owners, error)

// OwnerResolver is implemented by entity repositories that can resolve the
// owner chain of one of their rows by id.
type OwnerResolver interface {
	OwnerChain(ctx context.Context, id int64) (Owners, error)
}

// Data holds the owner resolver functions (OwnerChain implementations in the
// entity repositories). They are injected into the engine at startup.
type Data struct {
	ProjectOwners    ResolveByID
	ProcessOwners    ResolveByID
	TaskOwners       ResolveByID
	MilestoneOwners  ResolveByID
	AssignmentOwners ResolveByID
	ResourceOwners   ResolveByID
	WorkerOwners     ResolveByID
	CommentOwners    ResolveByID
}

// resolve returns the resolver for a resource (nil — the resource has no owner).
func (d Data) resolve(rsrc Resource) ResolveByID {
	switch rsrc {
	case ResourceProject:
		return d.ProjectOwners
	case ResourceProcess:
		return d.ProcessOwners
	case ResourceTask:
		return d.TaskOwners
	case ResourceMilestone:
		return d.MilestoneOwners
	case ResourceAssignment:
		return d.AssignmentOwners
	case ResourceResource:
		return d.ResourceOwners
	case ResourceWorker:
		return d.WorkerOwners
	case ResourceComment:
		return d.CommentOwners
	case ResourceState, ResourceUserCatalog, ResourceRBACConfig,
		ResourceUserAdmin, ResourceStateAdmin, ResourceOrgStructure, ResourceAudit, ResourceAutoCreate:
		// States and virtual resources have no owner.
		return nil
	default:
		return nil
	}
}

// Policy is an access rule for a route. All logic (role, owners, business
// rules) is hidden inside Check.
type Policy struct {
	Name  string
	Check func(rc *CheckCtx) error
}

// CheckCtx is the policy evaluation context.
type CheckCtx struct {
	C    *gin.Context
	User userctx.UserContext
	Data Data
	body []byte
}

// Body returns the request body (already restored for the handler).
func (rc *CheckCtx) Body() []byte {
	return rc.body
}

// ParamID returns the entity id from the URL (:id).
func (rc *CheckCtx) ParamID() (int64, error) {
	id, err := strconv.ParseInt(rc.C.Param("id"), 10, 64)
	if err != nil {
		return 0, errors.BadRequest("invalid id")
	}
	return id, nil
}

// BodyID extracts a numeric id from the body by key (0 if missing/null).
func (rc *CheckCtx) BodyID(key string) (int64, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(rc.body, &obj); err != nil {
		return 0, errors.BadRequest("invalid request body")
	}
	// The handler's JSON decoder matches tags case-insensitively; rejecting aliases
	// keeps authorization from overlooking an owner or parent change.
	for field := range obj {
		if strings.EqualFold(field, key) && field != key {
			return 0, errors.BadRequest("invalid request body")
		}
	}
	raw, ok := obj[key]
	if !ok || len(raw) == 0 || string(raw) == "null" {
		return 0, nil
	}
	var v int64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, errors.BadRequest("invalid request body")
	}
	return v, nil
}

// Owners returns the owner chain of an entity (via the resolver from Data).
// Missing entities are normalized to a clean "not found" error.
func (rc *CheckCtx) Owners(rsrc Resource, id int64) (Owners, error) {
	resolve := rc.Data.resolve(rsrc)
	if resolve == nil {
		return Owners{}, errors.NotFound("not found")
	}
	owners, err := resolve(rc.C.Request.Context(), id)
	if err != nil {
		if errors.IsNotFoundError(err) {
			return Owners{}, errors.NotFound("not found")
		}
		return Owners{}, err
	}
	return owners, nil
}

// Middleware is the policy engine.
type Middleware struct {
	logger *slog.Logger
	tracer *tracingpkg.Tracer
	data   Data
	byName atomic.Pointer[map[string]Policy]
}

// Check runs the policy by name, wrapped in its own trace span. An unknown
// name denies with 403 + ERROR log (the policy may have been deleted/corrupted
// in the DB; deny without revealing details instead of panicking).
func (m *Middleware) Check(name string) gin.HandlerFunc {
	return func(c *gin.Context) {
		ctx, end := m.tracer.Start(c.Request.Context(), "rbac."+name)
		c.Request = c.Request.WithContext(ctx)
		defer end(nil)

		byName := m.byName.Load()
		policy, ok := (*byName)[name]
		if !ok {
			if m.logger != nil {
				m.logger.ErrorContext(ctx, "rbac: policy not found", "policy", name)
			}
			response.Error(c, m.logger, errors.ErrForbidden)
			c.Abort()
			return
		}
		user, found := getUser(c)
		if !found {
			return
		}
		body, err := readBody(c)
		if err != nil {
			response.BadRequest(c, errors.CodeBadRequest, "invalid request body")
			c.Abort()
			return
		}
		rc := &CheckCtx{C: c, User: user, Data: m.data, body: body}
		if err = policy.Check(rc); err != nil {
			m.abort(c, err)
			return
		}
		c.Next()
	}
}

// Refresh atomically replaces the set of route checks (called by PolicyStore
// after each reload of rules from the DB).
func (m *Middleware) Refresh(policies []Policy) {
	byName := make(map[string]Policy, len(policies))
	for _, p := range policies {
		byName[p.Name] = p
	}
	m.byName.Store(&byName)
}

// abort writes the policy error as an HTTP response.
func (m *Middleware) abort(c *gin.Context, err error) {
	response.Error(c, m.logger, err)
	c.Abort()
}

// readBody reads the request body and restores it for the following handlers.
func readBody(c *gin.Context) ([]byte, error) {
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return nil, err
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))
	return body, nil
}

// getUser takes the user from the context (set by AuthMiddleware).
func getUser(c *gin.Context) (userctx.UserContext, bool) {
	user, err := userctx.GetUser(c)
	if err != nil {
		response.Unauthorized(c, errors.CodeUnauthorized, "authentication required")
		c.Abort()
		return userctx.UserContext{}, false
	}
	return user, true
}
