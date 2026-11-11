-- name: CreateMilestone :one
INSERT INTO milestones (process_id, title, content, color, date)
VALUES (@process_id, @title, @content, @color, @date)
RETURNING *;

-- name: ListMilestones :many
SELECT m.*
FROM milestones m
JOIN processes p ON p.id = m.process_id
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
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint)
ORDER BY m.id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountMilestones :one
SELECT COUNT(*)
FROM milestones m
JOIN processes p ON p.id = m.process_id
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
    (@sc_parent::boolean AND p.owner_id = @user_id::bigint) OR
    (@sc_ancestor::boolean AND (p.owner_id = @user_id::bigint OR pr.owner_id = @user_id::bigint)) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR p.owner_id = @owner_id::bigint OR pr.owner_id = @owner_id::bigint);

-- name: FindMilestone :one
SELECT *
FROM milestones
WHERE id = @milestone_id;
	
-- name: UpdateMilestone :one
UPDATE milestones
SET
	process_id = @process_id,
	title = @title,
	content = @content,
	color = @color,
	date = @date,
	updated_at = NOW()
WHERE id = @milestone_id
RETURNING *;
	
-- name: DeleteMilestone :exec
DELETE FROM milestones
WHERE id = @milestone_id;

-- name: OwnerChain :one
SELECT COALESCE(pr.owner_id, 0)::bigint AS project_owner,
       COALESCE(p.owner_id, 0)::bigint  AS process_owner
FROM milestones m
JOIN processes p ON p.id = m.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE m.id = @id::bigint;