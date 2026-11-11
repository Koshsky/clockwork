-- name: CreateTask :one
INSERT INTO tasks (process_id, parent_id, owner_id, responsible_id, title, color, status, start_date, end_date, sort_order)
SELECT
	@process_id::bigint,
	NULLIF(@parent_id::bigint, 0),
	@owner_id,
	@responsible_id,
	@title,
	@color,
	@status,
	@start_date,
	@end_date,
	-- New task goes to the end of its parent group: top-level tasks append
	-- within the process, subtasks within the parent task.
	CASE
		WHEN @parent_id::bigint IS NULL OR @parent_id::bigint = 0 THEN
			(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks
			 WHERE process_id = @process_id AND parent_id IS NULL)
		ELSE
			(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM tasks
			 WHERE parent_id = @parent_id)
	END
RETURNING *;

-- name: ListTasks :many
WITH RECURSIVE task_view_ancestors(descendant_id, ancestor_id) AS (
  SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL
  UNION
  SELECT a.descendant_id, t.parent_id
  FROM task_view_ancestors a JOIN tasks t ON t.id=a.ancestor_id
  WHERE t.parent_id IS NOT NULL
)
SELECT t.*
FROM tasks t
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
  ) OR EXISTS (
    SELECT 1 FROM task_view_ancestors va JOIN tasks at ON at.id=va.ancestor_id
    WHERE va.descendant_id=t.id AND (
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND at.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (at.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = at.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = at.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND t.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = t.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = t.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR t.owner_id = @owner_id::bigint OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint)
ORDER BY t.sort_order ASC, t.id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountTasks :one
WITH RECURSIVE task_view_ancestors(descendant_id, ancestor_id) AS (
  SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL
  UNION
  SELECT a.descendant_id, t.parent_id
  FROM task_view_ancestors a JOIN tasks t ON t.id=a.ancestor_id
  WHERE t.parent_id IS NOT NULL
)
SELECT COUNT(*)
FROM tasks t
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
  ) OR EXISTS (
    SELECT 1 FROM task_view_ancestors va JOIN tasks at ON at.id=va.ancestor_id
    WHERE va.descendant_id=t.id AND (
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND at.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (at.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = at.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = at.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND t.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (t.owner_id = @user_id::bigint OR p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = t.process_id
          AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.parent_id = t.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR t.owner_id = @owner_id::bigint OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint);

-- name: FindTask :one
SELECT *
FROM tasks
WHERE id = @resource_id::bigint;

-- name: UpdateTask :one
UPDATE tasks
SET
	owner_id = @owner_id,
	responsible_id = @responsible_id,
	title = @title,
	color = @color,
	status = @status,
	start_date = @start_date,
	end_date = @end_date,
	updated_at = NOW()
WHERE id = @task_id
RETURNING *;

-- name: ListSubtasksByParent :many
SELECT *
FROM tasks
WHERE parent_id = @parent_id::bigint
ORDER BY sort_order ASC, id ASC;

-- name: DeleteTask :exec
DELETE FROM tasks
WHERE id = @task_id;

-- name: OwnerChain :one
SELECT COALESCE(pr.owner_id, 0)::bigint AS project_owner,
       COALESCE(p.owner_id, 0)::bigint  AS process_owner,
       COALESCE(t.owner_id, 0)::bigint  AS owner_id
FROM tasks t
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE t.id = @id::bigint;

-- name: ReorderTasksMark :exec
-- Phase 1 of the two-phase reorder (runs inside one transaction with
-- ReorderTasksApply): park every task on a temporary offset slot so the
-- follow-up write cannot transiently violate the unique index
-- (process_id, parent group, sort_order) when values swap. The caller sends
-- the whole top-level group (subtasks keep their positions).
UPDATE tasks t
SET sort_order = x.ord + 1000000, updated_at = NOW()
FROM unnest(@ids::bigint[]) WITH ORDINALITY AS x(id, ord)
WHERE t.id = x.id;

-- name: ReorderTasksApply :exec
-- Phase 2 of the two-phase reorder: write the final positions. The group is
-- the whole active top-level set of the process (validated by the caller), so
-- no target slot collides with rows outside the group.
UPDATE tasks t
SET sort_order = x.ord, updated_at = NOW()
FROM unnest(@ids::bigint[]) WITH ORDINALITY AS x(id, ord)
WHERE t.id = x.id;

-- name: ListTaskIdsByProcess :many
-- Active top-level task ids of a process — to validate a reorder request
-- covers the whole (top-level) group. Subtasks are managed by their parent
-- and are not reorderable.
SELECT id
FROM tasks
WHERE process_id = @process_id::bigint
	AND parent_id IS NULL
ORDER BY sort_order ASC, id ASC;