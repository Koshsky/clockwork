package service

import (
	"context"

	"github.com/Koshsky/erp-backend/internal/authz/engine"
	"github.com/Koshsky/erp-backend/internal/middleware/rbac"
)

func (p *OwnerProbe) parents(ctx context.Context, res rbac.Resource, id int64) ([]engine.Target, error) {
	if res == rbac.ResourceProcess {
		var target engine.Target
		target.Res = rbac.ResourceProject
		err := p.executor(ctx).QueryRow(ctx, `
 SELECT pr.id, COALESCE(pr.owner_id,0) FROM projects pr
 JOIN processes p ON p.project_id=pr.id WHERE p.id=$1`, id).
			Scan(&target.ID, &target.Owners.ProjectOwner)
		if err != nil {
			return nil, err
		}
		return []engine.Target{target}, nil
	}
	subject := viewParentSubject(res)
	if subject == "" {
		return nil, nil
	}
	query := `WITH RECURSIVE subject AS (` + subject + `),
 task_chain AS (
 SELECT t.id,t.parent_id,t.process_id,t.owner_id FROM tasks t JOIN subject s ON t.id=s.task_id
 UNION
 SELECT t.id,t.parent_id,t.process_id,t.owner_id FROM tasks t JOIN task_chain child ON t.id=child.parent_id
 )
 SELECT $2::int, pr.id, COALESCE(pr.owner_id,0), 0::bigint, 0::bigint
 FROM subject s JOIN processes p ON p.id=s.process_id JOIN projects pr ON pr.id=p.project_id
 UNION ALL
 SELECT $3::int, p.id, COALESCE(pr.owner_id,0), COALESCE(p.owner_id,0), 0::bigint
 FROM subject s JOIN processes p ON p.id=s.process_id JOIN projects pr ON pr.id=p.project_id
 UNION ALL
 SELECT $4::int, t.id, COALESCE(pr.owner_id,0), COALESCE(p.owner_id,0), COALESCE(t.owner_id,0)
 FROM task_chain t JOIN processes p ON p.id=t.process_id JOIN projects pr ON pr.id=p.project_id`
	rows, err := p.executor(ctx).Query(ctx, query, id,
		int(rbac.ResourceProject), int(rbac.ResourceProcess), int(rbac.ResourceTask))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var targets []engine.Target
	for rows.Next() {
		var target engine.Target
		if err = rows.Scan(&target.Res, &target.ID, &target.Owners.ProjectOwner,
			&target.Owners.ProcessOwner, &target.Owners.Owner); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func viewParentSubject(res rbac.Resource) string {
	switch res {
	case rbac.ResourceTask:
		return `SELECT process_id, parent_id AS task_id FROM tasks WHERE id=$1`
	case rbac.ResourceMilestone:
		return `SELECT process_id, NULL::bigint AS task_id FROM milestones WHERE id=$1`
	case rbac.ResourceAssignment:
		return `SELECT t.process_id,t.id AS task_id FROM assignments a JOIN tasks t ON t.id=a.task_id WHERE a.id=$1`
	case rbac.ResourceProject,
		rbac.ResourceProcess,
		rbac.ResourceState,
		rbac.ResourceResource,
		rbac.ResourceWorker,
		rbac.ResourceComment,
		rbac.ResourceUserCatalog,
		rbac.ResourceRBACConfig,
		rbac.ResourceUserAdmin,
		rbac.ResourceStateAdmin,
		rbac.ResourceOrgStructure,
		rbac.ResourceAudit, rbac.ResourceAutoCreate:
		return ""
	}
	return ""
}
