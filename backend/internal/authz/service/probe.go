package service

import (
	"context"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/database"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

// OwnerProbe implements the data-dependent scope moves of the ownership tree
// (engine.OwnerProbe): "does the user own a descendant/sibling node" — the
// questions the entity checks need beyond the owner chain. The list side is
// covered by the generated SQL skeletons; this probe covers the single-entity
// route checks for the sib/down moves.
type OwnerProbe struct {
	pool *pgxpool.Pool
}

// NewOwnerProbe builds the OwnerProbe probe and installs it into the engine
// (the wire graph constructs it once at startup; a nil probe would leave the
// sib/down moves disabled).
func NewOwnerProbe(pool *pgxpool.Pool) *OwnerProbe {
	p := &OwnerProbe{pool: pool}
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Descendant: p.descendant,
		Peer:       p.peer,
		Related:    p.related,
		Parents:    p.parents,
	})
	return p
}

// Register installs the probe into the engine (idempotent; kept for tests).
func (p *OwnerProbe) Register() *OwnerProbe {
	engine.SetOwnerProbe(&engine.OwnerProbe{
		Descendant: p.descendant,
		Peer:       p.peer,
		Related:    p.related,
		Parents:    p.parents,
	})
	return p
}

// executor resolves the query handle: the request-scoped transaction when one
// is active (idempotency middleware), otherwise the shared pool.
func (p *OwnerProbe) executor(ctx context.Context) interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
} {
	if tx, ok := database.TxFrom(ctx); ok {
		return tx
	}
	return p.pool
}

// descendant reports whether the user owns a descendant node below (res, id).
func (p *OwnerProbe) descendant(ctx context.Context, res rbac.Resource, id, userID int64) (bool, error) {
	switch res {
	case rbac.ResourceProject:
		return p.exists(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM processes dp
				WHERE dp.project_id = $1 AND dp.owner_id = $2
			) OR EXISTS (
				SELECT 1 FROM tasks d
				JOIN processes dp ON dp.id = d.process_id
				WHERE dp.project_id = $1 AND d.owner_id = $2
			)`, id, userID)
	case rbac.ResourceProcess:
		return p.exists(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM tasks d
				WHERE d.process_id = $1 AND d.owner_id = $2
			)`, id, userID)
	case rbac.ResourceTask:
		return p.exists(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM tasks d
				WHERE d.parent_id = $1 AND d.owner_id = $2
			)`, id, userID)
	case rbac.ResourceMilestone, rbac.ResourceAssignment, rbac.ResourceState,
		rbac.ResourceResource, rbac.ResourceWorker, rbac.ResourceComment,
		rbac.ResourceUserCatalog, rbac.ResourceRBACConfig, rbac.ResourceUserAdmin,
		rbac.ResourceStateAdmin, rbac.ResourceOrgStructure, rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return false, nil
	}
	return false, nil
}

func (p *OwnerProbe) peer(ctx context.Context, target engine.Target, userID int64, project bool) (bool, error) {
	switch target.Res {
	case rbac.ResourceProcess:
		if project {
			return false, nil
		}
		return p.exists(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM processes s
				WHERE s.project_id = COALESCE(NULLIF($3::bigint, 0), (SELECT project_id FROM processes WHERE id = $1))
				  AND s.owner_id = $2
			)`, target.ID, userID, target.ParentID)
	case rbac.ResourceTask:
		return p.exists(ctx, `
			WITH destination AS (
				SELECT id, project_id FROM processes
				WHERE id = COALESCE(NULLIF($3::bigint, 0), (SELECT process_id FROM tasks WHERE id = $1))
			)
			SELECT EXISTS (
				SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
				JOIN destination d ON CASE WHEN $4::boolean THEN sp.project_id = d.project_id ELSE sp.id = d.id END
				WHERE s.owner_id = $2
			)`, target.ID, userID, target.ParentID, project)
	case rbac.ResourceProject, rbac.ResourceMilestone, rbac.ResourceAssignment,
		rbac.ResourceState, rbac.ResourceResource, rbac.ResourceWorker,
		rbac.ResourceComment, rbac.ResourceUserCatalog, rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin, rbac.ResourceStateAdmin, rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return false, nil
	}
	return false, nil
}

func (p *OwnerProbe) related(ctx context.Context, target engine.Target, userID int64, scope string) (bool, error) {
	if scope == engine.ScopeProcessProjects && target.Res == rbac.ResourceProject {
		return p.exists(ctx, `SELECT EXISTS (
			SELECT 1 FROM processes WHERE project_id = $1 AND owner_id = $2
		)`, target.ID, userID)
	}
	if scope == engine.ScopeProjectResources && target.Res == rbac.ResourceResource {
		return p.exists(ctx, `SELECT EXISTS (
			SELECT 1 FROM resources r JOIN processes p ON p.owner_id = r.owner_id
			JOIN projects pr ON pr.id = p.project_id
			WHERE r.id = $1 AND pr.owner_id = $2
		)`, target.ID, userID)
	}
	return false, nil
}

// exists runs a boolean query.
func (p *OwnerProbe) exists(ctx context.Context, sql string, args ...any) (bool, error) {
	var ok bool
	err := p.executor(ctx).QueryRow(ctx, sql, args...).Scan(&ok)
	if err != nil {
		return false, err
	}
	return ok, nil
}
