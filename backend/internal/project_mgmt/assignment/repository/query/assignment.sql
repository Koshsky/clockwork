-- name: CreateAssignment :one
-- Idempotent create: if the (task_id, resource_id) link is already active
-- we insert nothing; an existing row is reported back to the calling
-- code (repository) via FindAssignmentByKey.
INSERT INTO assignments (task_id, resource_id, quantity)
VALUES (@task_id, @resource_id, @quantity::bigint)
ON CONFLICT (task_id, resource_id)
DO NOTHING
RETURNING *;

-- name: FindAssignmentByKey :one
SELECT *
FROM assignments
WHERE task_id = @task_id::bigint
	AND resource_id = @resource_id::bigint
LIMIT 1;

-- name: FindAssignment :one
SELECT *
FROM assignments
WHERE id = @assignment_id;
-- name: ListAssigments :many
WITH RECURSIVE task_view_ancestors(descendant_id, ancestor_id) AS (
  SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL
  UNION
  SELECT a.descendant_id, t.parent_id
  FROM task_view_ancestors a JOIN tasks t ON t.id=a.ancestor_id
  WHERE t.parent_id IS NOT NULL
)
SELECT a.*
FROM assignments a
JOIN tasks t ON t.id = a.task_id
JOIN resources r ON r.id = a.resource_id
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE (
    ((
    ('all' = ANY(@project_view::text[])) OR
    (('self' = ANY(@project_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_projects' = ANY(@project_view::text[])) AND EXISTS (
        SELECT 1 FROM processes vp WHERE vp.project_id = pr.id AND vp.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@project_view::text[])) AND (EXISTS (
        SELECT 1 FROM processes dp
        WHERE dp.project_id = pr.id AND dp.owner_id = @user_id::bigint
    ) OR EXISTS (
        SELECT 1 FROM tasks d
        JOIN processes dp ON dp.id = d.process_id
        WHERE dp.project_id = pr.id AND d.owner_id = @user_id::bigint
    ))) OR
    false
  ) OR (
    ('all' = ANY(@process_view::text[])) OR
    (('project_owner' = ANY(@process_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@process_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@process_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@process_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@process_view::text[])) AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@process_view::text[])) AND EXISTS (
        SELECT 1 FROM processes s
        WHERE s.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@process_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  ) OR (
    ('all' = ANY(@task_view::text[])) OR
    (('project_owner' = ANY(@task_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@task_view::text[])) AND t.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@task_view::text[])) AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = t.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (('project_sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = t.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  ) OR EXISTS (
    SELECT 1 FROM task_view_ancestors va JOIN tasks at ON at.id=va.ancestor_id
    WHERE va.descendant_id=t.id AND (
    ('all' = ANY(@task_view::text[])) OR
    (('project_owner' = ANY(@task_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@task_view::text[])) AND at.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@task_view::text[])) AND (at.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = at.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (('project_sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = at.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  )
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND t.owner_id = @user_id::bigint AND r.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR t.owner_id = @owner_id::bigint OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint)
ORDER BY a.id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountAssignments :one
WITH RECURSIVE task_view_ancestors(descendant_id, ancestor_id) AS (
  SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL
  UNION
  SELECT a.descendant_id, t.parent_id
  FROM task_view_ancestors a JOIN tasks t ON t.id=a.ancestor_id
  WHERE t.parent_id IS NOT NULL
)
SELECT COUNT(*)
FROM assignments a
JOIN tasks t ON t.id = a.task_id
JOIN resources r ON r.id = a.resource_id
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE (
    ((
    ('all' = ANY(@project_view::text[])) OR
    (('self' = ANY(@project_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_projects' = ANY(@project_view::text[])) AND EXISTS (
        SELECT 1 FROM processes vp WHERE vp.project_id = pr.id AND vp.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@project_view::text[])) AND (EXISTS (
        SELECT 1 FROM processes dp
        WHERE dp.project_id = pr.id AND dp.owner_id = @user_id::bigint
    ) OR EXISTS (
        SELECT 1 FROM tasks d
        JOIN processes dp ON dp.id = d.process_id
        WHERE dp.project_id = pr.id AND d.owner_id = @user_id::bigint
    ))) OR
    false
  ) OR (
    ('all' = ANY(@process_view::text[])) OR
    (('project_owner' = ANY(@process_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@process_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@process_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@process_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@process_view::text[])) AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@process_view::text[])) AND EXISTS (
        SELECT 1 FROM processes s
        WHERE s.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@process_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  ) OR (
    ('all' = ANY(@task_view::text[])) OR
    (('project_owner' = ANY(@task_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@task_view::text[])) AND t.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@task_view::text[])) AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = t.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (('project_sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = t.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  ) OR EXISTS (
    SELECT 1 FROM task_view_ancestors va JOIN tasks at ON at.id=va.ancestor_id
    WHERE va.descendant_id=t.id AND (
    ('all' = ANY(@task_view::text[])) OR
    (('project_owner' = ANY(@task_view::text[])) AND pr.owner_id = @user_id::bigint) OR
    (('process_owner' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('self' = ANY(@task_view::text[])) AND at.owner_id = @user_id::bigint) OR
    (('parent' = ANY(@task_view::text[])) AND p.owner_id = @user_id::bigint) OR
    (('ancestor' = ANY(@task_view::text[])) AND (at.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (('sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = at.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (('project_sib' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (('down' = ANY(@task_view::text[])) AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = at.id AND d.owner_id = @user_id::bigint
    )) OR
    false
  )
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND t.owner_id = @user_id::bigint AND r.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR t.owner_id = @owner_id::bigint OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint);

-- name: UpdateAssignment :one
UPDATE assignments
SET
	task_id = @task_id,
	resource_id = @resource_id,
	quantity = @quantity::bigint,
	updated_at = NOW()
WHERE id = @assignment_id
RETURNING *;

-- name: DeleteAssignment :exec
DELETE FROM assignments
WHERE id = @assignment_id;

-- name: OwnerChain :one
SELECT COALESCE(pr.owner_id, 0)::bigint AS project_owner,
       COALESCE(p.owner_id, 0)::bigint  AS process_owner,
       COALESCE(t.owner_id, 0)::bigint  AS owner_id,
       COALESCE(r.owner_id, 0)::bigint  AS resource_owner
FROM assignments a
JOIN tasks t ON t.id = a.task_id
JOIN resources r ON r.id = a.resource_id
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE a.id = @id::bigint;
