-- name: CreateProject :one
-- Idempotent create by business key code: if an active code already exists
-- we insert nothing; the calling code (repository) turns the conflict into 409.
INSERT INTO projects (code, start_date, end_date, priority, owner_id, responsible_id, color)
VALUES (
  @code::text,
  @start_date::date,
  @end_date::date,
  @priority::bigint,
  @owner_id,
  @responsible_id,
  @color
)
ON CONFLICT (code)
DO NOTHING
RETURNING *;

-- name: ListProjects :many
SELECT *
FROM projects
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
  AND (@owner_id::bigint = 0 OR owner_id = @owner_id::bigint)
ORDER BY id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountProjects :one
SELECT COUNT(*)
FROM projects
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
  AND (@owner_id::bigint = 0 OR owner_id = @owner_id::bigint);

-- name: FindProject :one
SELECT *
FROM projects
WHERE id = @project_id::bigint;

-- name: UpdateProject :one
UPDATE projects
SET
	code = @code,
	color = @color,
	priority = @priority::bigint,
	start_date = @start_date,
	end_date = @end_date,
  owner_id = @owner_id,
  responsible_id = @responsible_id,
	updated_at = NOW()
WHERE id = @project_id::bigint
RETURNING *;

-- name: DeleteProject :exec
DELETE FROM projects
WHERE id = @project_id::bigint;

-- name: OwnerChain :one
SELECT COALESCE(owner_id, 0)::bigint AS owner_id
FROM projects
WHERE id = @id::bigint;

-- name: CountAutoCreatedEntities :one
-- The auto-create trigger (V8) fills a project with processes/tasks/assignments
-- from the template on insert. Counts reflect what the trigger effectively
-- created (all zero when the template is disabled or empty).
SELECT
  (SELECT COUNT(*) FROM processes
     WHERE project_id = @project_id::bigint) AS processes,
  (SELECT COUNT(*) FROM tasks t
     JOIN processes p ON p.id = t.process_id
     WHERE p.project_id = @project_id::bigint) AS tasks,
  (SELECT COUNT(*) FROM assignments a
     JOIN tasks t ON t.id = a.task_id
     JOIN processes p ON p.id = t.process_id
     WHERE p.project_id = @project_id::bigint) AS assignments;