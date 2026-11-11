-- name: ListProjects :many
SELECT * FROM projects
WHERE (
    @sc_all::boolean OR
    (@sc_process_projects::boolean AND EXISTS (
        SELECT 1 FROM processes vp WHERE vp.project_id = projects.id AND vp.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    (@sc_down::boolean AND (EXISTS (
        SELECT 1 FROM processes dp
        WHERE dp.project_id = projects.id AND dp.owner_id = @user_id::bigint
    ) OR EXISTS (
        SELECT 1 FROM tasks d
        JOIN processes dp ON dp.id = d.process_id
        WHERE dp.project_id = projects.id AND d.owner_id = @user_id::bigint
    ))) OR
    @sc_none::boolean
)
ORDER BY priority ASC;

-- name: ListProcesses :many
SELECT sqlc.embed(p), pr.code AS project_code, pr.owner_id AS project_owner_id
FROM processes p
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
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_parent::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM processes s
        WHERE s.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
);

-- name: ListProcessesByTaskScope :many
-- Processes for the TASK planning aggregate: the scope comes from the task
-- matrix, where 'parent' means "in my processes" (p.owner_id), not "in my
-- projects" (pr.owner_id) — the process list must follow the task semantics,
-- otherwise a process owner (vp) sees an empty task diagram although the
-- process view lists their processes.
SELECT sqlc.embed(p), pr.code AS project_code, pr.owner_id AS project_owner_id
FROM processes p
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
  )) OR
    @sc_all::boolean OR
    (@sc_project_owner::boolean AND pr.owner_id = @user_id::bigint) OR
    (@sc_process_owner::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_self::boolean AND EXISTS (
        SELECT 1 FROM tasks t WHERE t.process_id = p.id AND t.owner_id = @user_id::bigint
    )) OR
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    (@sc_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s
        WHERE s.process_id = p.id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_project_sib::boolean AND EXISTS (
        SELECT 1 FROM tasks s JOIN processes sp ON sp.id = s.process_id
        WHERE sp.project_id = p.project_id AND s.owner_id = @user_id::bigint
    )) OR
    (@sc_down::boolean AND EXISTS (
        SELECT 1 FROM tasks d
        WHERE d.process_id = p.id AND d.owner_id = @user_id::bigint
    )) OR
    @sc_none::boolean
  );

-- name: ListResources :many
-- Resources embedded into task/reference data, scoped by the caller's
-- resource view zone: a task-view holder with a resource zone must not
-- receive resource rows outside it (resource is own-scoped for vp). A caller
-- with no resource view rule (empty zone — "no rule / none") gets every row:
-- reference data must not hide the visible tasks.
SELECT * FROM resources
WHERE (
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = resources.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    @sc_none::boolean
);


-- name: ListProjectsByIDs :many
-- Projects attached as parent context of the caller's visible processes,
-- scoped by the caller's project view zone: the process aggregate must not
-- disclose full project rows of projects outside that zone. A caller with no
-- project view rule (empty zone — e.g. vp, which sees processes through
-- process.view=all) gets every requested parent project: reference rows with
-- no resolved zone must not hide the visible processes.
SELECT * FROM projects
WHERE id = ANY(@ids::bigint[])
  AND (
    @sc_all::boolean OR
    (@sc_process_projects::boolean AND EXISTS (
        SELECT 1 FROM processes vp WHERE vp.project_id = projects.id AND vp.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    (@sc_down::boolean AND (EXISTS (
        SELECT 1 FROM processes dp
        WHERE dp.project_id = projects.id AND dp.owner_id = @user_id::bigint
    ) OR EXISTS (
        SELECT 1 FROM tasks d
        JOIN processes dp ON dp.id = d.process_id
        WHERE dp.project_id = projects.id AND d.owner_id = @user_id::bigint
    ))) OR
    @sc_none::boolean
  );


-- name: ListProcessesByProjectIDs :many
SELECT * FROM processes
WHERE project_id = ANY(@project_ids::bigint[])
ORDER BY sort_order ASC, id ASC;

-- name: ListMilestonesByProcessIDs :many
SELECT * FROM milestones
WHERE process_id = ANY(@process_ids::bigint[])
ORDER BY id ASC;

-- name: ListTasksByProcessIDs :many
WITH RECURSIVE task_view_ancestors(descendant_id, ancestor_id) AS (
  SELECT id, parent_id FROM tasks WHERE parent_id IS NOT NULL
  UNION
  SELECT a.descendant_id, t.parent_id
  FROM task_view_ancestors a JOIN tasks t ON t.id=a.ancestor_id
  WHERE t.parent_id IS NOT NULL
)
SELECT t.* FROM tasks t
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE t.process_id = ANY(@process_ids::bigint[])
AND (
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
ORDER BY COALESCE(t.parent_id, 0), t.sort_order ASC, t.id ASC;

-- name: ListAssignmentsByTaskIDs :many
SELECT * FROM assignments
WHERE task_id = ANY(@task_ids::bigint[])
ORDER BY id ASC;

-- name: ListTaskCommentCountsByTaskIDs :many
SELECT task_id, COUNT(*)::bigint AS comments_count
FROM task_comments
WHERE task_id = ANY(@task_ids::bigint[])
GROUP BY task_id;

-- name: ListTaskDependenciesByProcessIDs :many
-- Scheduling links between tasks of the given processes (both ends are
-- top-level tasks of the same process — enforced at creation).
SELECT sqlc.embed(td)
FROM task_dependencies td
JOIN tasks t ON t.id = td.task_id
WHERE t.process_id = ANY(@process_ids::bigint[])
ORDER BY td.task_id ASC, td.id ASC;