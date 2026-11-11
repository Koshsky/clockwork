-- name: CreateProcess :one
INSERT INTO processes (project_id, title, start_date, end_date, owner_id, responsible_id, color, sort_order)
VALUES (
	@project_id::bigint,
	@title::text,
	@start_date::date,
	@end_date::date,
	@owner_id,
	@responsible_id,
	@color,
	-- New process goes to the end of its project group.
	(SELECT COALESCE(MAX(sort_order), 0) + 1 FROM processes WHERE project_id = @project_id::bigint)
)
RETURNING *;

-- name: ListProcesss :many
SELECT p.*
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
  )
  AND (@owner_id::bigint = 0 OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint)
ORDER BY p.sort_order ASC, p.id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountProcesses :one
SELECT COUNT(*)
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
  )
  AND (@owner_id::bigint = 0 OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint);

-- name: FindProcess :one
SELECT *
FROM processes
WHERE id = @id::bigint;
    

-- name: UpdateProcess :one
UPDATE processes
SET
	title = @title,
	color = @color,
	start_date = @start_date,
	end_date = @end_date,
	project_id = COALESCE(@project_id, project_id),
	owner_id = COALESCE(@owner_id, owner_id),
	responsible_id = @responsible_id,
	updated_at = NOW()
WHERE id = @process_id::bigint
RETURNING *;

-- name: DeleteProcess :exec
DELETE FROM processes
WHERE id = @process_id::bigint;

-- name: OwnerChain :one
SELECT COALESCE(pr.owner_id, 0)::bigint AS project_owner,
       COALESCE(p.owner_id, 0)::bigint  AS process_owner
FROM processes p
JOIN projects pr ON pr.id = p.project_id
WHERE p.id = @id::bigint;

-- name: ReorderProcessesMark :exec
-- Phase 1 of the two-phase reorder (runs inside one transaction with
-- ReorderProcessesApply): park every process on a temporary offset slot so the
-- follow-up write cannot transiently violate the unique index
-- (project_id, sort_order) when values swap. The caller sends the whole group.
UPDATE processes p
SET sort_order = x.ord + 1000000, updated_at = NOW()
FROM unnest(@ids::bigint[]) WITH ORDINALITY AS x(id, ord)
WHERE p.id = x.id;

-- name: ReorderProcessesApply :exec
-- Phase 2 of the two-phase reorder: write the final positions. The group is
-- the whole active set of the project (validated by the caller), so no target
-- slot collides with rows outside the group.
UPDATE processes p
SET sort_order = x.ord, updated_at = NOW()
FROM unnest(@ids::bigint[]) WITH ORDINALITY AS x(id, ord)
WHERE p.id = x.id;

-- name: ListProcessIdsByProject :many
-- Active process ids of a project — to validate a reorder request covers the
-- whole group.
SELECT id
FROM processes
WHERE project_id = @project_id::bigint
ORDER BY sort_order ASC, id ASC;