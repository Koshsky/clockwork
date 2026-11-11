-- name: ListResources :many
SELECT r.id, r.code, r.title, r.color, r.owner_id,
    COUNT(rm.user_id)::bigint AS employees_count,
    r.created_at, r.updated_at
FROM resources r
LEFT JOIN resource_members rm ON rm.resource_id = r.id
WHERE (
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = r.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND r.owner_id = @user_id::bigint) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR r.owner_id = @owner_id::bigint)
GROUP BY r.id, r.code, r.title, r.color, r.owner_id, r.created_at, r.updated_at
ORDER BY r.id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountResources :one
SELECT COUNT(*)
FROM resources
WHERE (
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = resources.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    @sc_none::boolean
  )
  AND (@owner_id::bigint = 0 OR owner_id = @owner_id::bigint);

-- name: ListResourcesByOwnerID :many
SELECT r.id, r.code, r.title, r.color, r.owner_id,
    COUNT(rm.user_id)::bigint AS employees_count,
    r.created_at, r.updated_at
FROM resources r
LEFT JOIN resource_members rm ON rm.resource_id = r.id
WHERE r.owner_id = @owner_id::bigint
GROUP BY r.id, r.code, r.title, r.color, r.owner_id, r.created_at, r.updated_at
ORDER BY r.id ASC;

-- name: FindResource :one
SELECT r.id, r.code, r.title, r.color, r.owner_id,
    COUNT(rm.user_id)::bigint AS employees_count,
    r.created_at, r.updated_at
FROM resources r
LEFT JOIN resource_members rm ON rm.resource_id = r.id
WHERE r.id = @resource_id::bigint
GROUP BY r.id, r.code, r.title, r.color, r.owner_id, r.created_at, r.updated_at;

-- name: CreateResource :one
-- Idempotent create by business key code: if an active code already exists
-- we insert nothing; the calling code (repository) turns the conflict into 409.
INSERT INTO resources (title, code, color, owner_id)
VALUES (@title, @code, @color, @owner_id)
ON CONFLICT (code)
DO NOTHING
RETURNING *;

-- name: CountMembersByResourceID :one
SELECT COUNT(*)::bigint
FROM resource_members
WHERE resource_id = @resource_id::bigint;

-- name: UpdateResource :one
UPDATE resources
SET
	title = @title,
	code = @code,
	color = @color,
	owner_id = @owner_id,
	updated_at = NOW()
WHERE id = @resource_id
RETURNING *;

-- name: DeleteResource :exec
DELETE FROM resources
WHERE id = @resource_id;

-- name: OwnerChain :one
SELECT COALESCE(owner_id, 0)::bigint AS owner_id
FROM resources
WHERE id = @id::bigint;

-- ================= resource members =================

-- name: ListMembersByResourceID :many
SELECT u.id, CONCAT_WS(' ', NULLIF(u.last_name, ''), NULLIF(u.first_name, ''), NULLIF(u.middle_name, '')) AS name,
       u.preset, u.position, u.hire_date, u.termination_date, u.manager_id
FROM resource_members rm
JOIN users u ON u.id = rm.user_id
WHERE rm.resource_id = @resource_id::bigint
ORDER BY u.id ASC;

-- name: AddMember :exec
INSERT INTO resource_members (resource_id, user_id)
VALUES (@resource_id::bigint, @user_id::bigint)
ON CONFLICT DO NOTHING;

-- name: RemoveMember :exec
DELETE FROM resource_members
WHERE resource_id = @resource_id::bigint
  AND user_id = @user_id::bigint;

-- name: FindUserManager :one
SELECT manager_id
FROM users
WHERE id = @user_id::bigint;

-- Resource member absences (states with is_available = false) for the window.
-- name: ListResourceAbsence :many
SELECT u.id AS user_id,
       CONCAT_WS(' ', NULLIF(u.last_name, ''), NULLIF(u.first_name, ''), NULLIF(u.middle_name, '')) AS user_name,
       s.id AS state_id, s.code AS state_code, s.name AS state_name,
       es.start_date, es.end_date
FROM user_states es
JOIN resource_members rm ON rm.user_id = es.user_id AND rm.resource_id = @resource_id::bigint
JOIN users u ON u.id = es.user_id
JOIN states s ON s.id = es.state_id
WHERE s.is_available = FALSE
  AND es.end_date >= @start_date::date
  AND es.start_date <= @end_date::date
ORDER BY es.start_date ASC, u.last_name ASC;