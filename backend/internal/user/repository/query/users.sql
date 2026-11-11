-- name: ListUsers :many
SELECT *
FROM users
WHERE (
    @sc_all::boolean OR
    (@sc_self::boolean AND manager_id = @user_id::bigint) OR
    @sc_none::boolean
  )
  -- For non-admin: only direct subordinates (manager_id = current user);
  -- admin sees everyone. The user himself is not included here (the timesheet
  -- adds oneself on the client separately).
  AND (@preset_filter::text = '' OR preset = @preset_filter::text)
  AND (@manager_id::bigint = 0 OR manager_id = @manager_id::bigint)
  -- Optional search: a case-insensitive substring over the composed full name
  -- (last + first + middle) or the login; an empty pattern disables the filter.
  -- The caller passes the pattern already lowercased and escaped (see the
  -- normalizeSearch helper in user/service).
  AND (
    @search::text = '' OR
    LOWER(
      last_name || ' ' || first_name || ' ' || COALESCE(middle_name, '')
    ) LIKE '%' || @search::text || '%' ESCAPE '\' OR
    LOWER(username) LIKE '%' || @search::text || '%' ESCAPE '\'
  )
ORDER BY id ASC
LIMIT @page_limit::bigint OFFSET @page_offset::bigint;

-- name: CountUsers :one
SELECT COUNT(*)
FROM users
WHERE (
    @sc_all::boolean OR
    (@sc_self::boolean AND manager_id = @user_id::bigint) OR
    @sc_none::boolean
  )
  AND (@preset_filter::text = '' OR preset = @preset_filter::text)
  AND (@manager_id::bigint = 0 OR manager_id = @manager_id::bigint)
  AND (
    @search::text = '' OR
    LOWER(
      last_name || ' ' || first_name || ' ' || COALESCE(middle_name, '')
    ) LIKE '%' || @search::text || '%' ESCAPE '\' OR
    LOWER(username) LIKE '%' || @search::text || '%' ESCAPE '\'
  );

-- name: ListAllUsers :many
SELECT *
FROM users
ORDER BY id ASC;

-- name: FindUser :one
SELECT *
FROM users
WHERE id = @user_id
LIMIT 1;

-- name: FindUserByUsername :one
SELECT *
FROM users
WHERE username = @username
LIMIT 1;

-- name: UsernameExists :one
SELECT EXISTS(
	SELECT 1
	FROM users
	WHERE username = @username
);

-- name: ListUsersByIDs :many
-- Batch owner lookup for scope checks: the (id, manager_id) pairs of the
-- requested users in one round trip (replaces N FindUser calls per request).
SELECT id, manager_id
FROM users
WHERE id = ANY(@user_ids::bigint[]);

-- name: CreateUser :one
INSERT INTO users (last_name, first_name, middle_name, username, preset, password_hash, manager_id, position, hire_date, termination_date)
VALUES (@last_name, @first_name, @middle_name, @username, @preset, @password_hash, @manager_id, @position, @hire_date, @termination_date)
RETURNING *;

-- name: UpdateUser :one
UPDATE users
SET
	last_name = @last_name,
	first_name = @first_name,
	middle_name = @middle_name,
	username = @username,
	preset = @preset,
	password_hash = @password_hash,
	manager_id = @manager_id,
	position = @position,
	hire_date = @hire_date,
	termination_date = @termination_date,
	updated_at = NOW()
WHERE id = @user_id
RETURNING *;

-- name: UpdateUserPassword :exec
UPDATE users
SET password_hash = @password_hash, updated_at = NOW()
WHERE id = @user_id;

-- name: InsertUserPermission :exec
-- Individual permission override created together with the user account
-- (same table/semantics as rbacpolicy's user_permissions).
INSERT INTO user_permissions (user_id, resource, action, scope, granted, updated_by)
VALUES (@user_id::bigint, @resource::text, @action::text, @scope::text, @granted, @updated_by);

-- name: DeleteUser :exec
DELETE FROM users
WHERE id = @user_id;

-- name: ListUserReferences :one
-- Counts of records that reference the user and block deletion (FK RESTRICT):
-- managees, owned resources/projects/processes/tasks, comment authorship and
-- auto-create template owners stored in the jsonb config (no FK, but a deleted
-- owner would break template-driven project creation). The jsonb walk is
-- defensive: a malformed/legacy config (non-array shape, or an element with a
-- missing/null/non-numeric owner_id) must not abort the deletion precheck with
-- a cast or extraction error — elements are matched by strict jsonb equality
-- with the numeric user id, so anything that is not the same JSON number
-- simply does not match.
SELECT
    (SELECT count(*)::bigint FROM users u WHERE u.manager_id = @user_id::bigint) AS managees,
    (SELECT count(*)::bigint FROM resources r WHERE r.owner_id = @user_id::bigint) AS resources,
    (SELECT count(*)::bigint FROM projects p WHERE p.owner_id = @user_id::bigint) AS projects,
    (SELECT count(*)::bigint FROM processes pr WHERE pr.owner_id = @user_id::bigint) AS processes,
    (SELECT count(*)::bigint FROM tasks t WHERE t.owner_id = @user_id::bigint) AS tasks,
    (SELECT count(*)::bigint FROM task_comments c WHERE c.author_id = @user_id::bigint) AS comments,
    (SELECT count(*)::bigint
     FROM project_auto_create pac, jsonb_array_elements(
       CASE WHEN jsonb_typeof(pac.config) = 'array' THEN pac.config ELSE '[]'::jsonb END
     ) e
     WHERE e->'owner_id' = to_jsonb(@user_id::bigint)) AS auto_create_templates;

-- name: OwnerChain :one
-- Record owner: the manager, or the user himself when there is none
-- (so a user can see/edit their own timesheet).
SELECT COALESCE(manager_id, id)::bigint AS owner_id
FROM users
WHERE id = @id::bigint;

-- ================= worker days (user_states) =================

-- name: ListStatesByUserRange :many
SELECT es.id, es.user_id, es.start_date, es.end_date, es.state_id,
	s.code AS state_code, s.name AS state_name, s.is_available
FROM user_states es
JOIN states s ON s.id = es.state_id
WHERE es.user_id = @user_id::bigint
	AND es.end_date >= @start_date::date
	AND es.start_date <= @end_date::date
ORDER BY es.start_date ASC;

-- name: ListStatesByUsersRange :many
-- Batch variant of ListStatesByUserRange for a set of workers in one request
-- (no N+1 per employee). The rows of the range are ordered by user so the
-- caller can group them without sorting.
SELECT es.id, es.user_id, es.start_date, es.end_date, es.state_id,
	s.code AS state_code, s.name AS state_name, s.is_available
FROM user_states es
JOIN states s ON s.id = es.state_id
WHERE es.user_id = ANY(@user_ids::bigint[])
	AND es.end_date >= @start_date::date
	AND es.start_date <= @end_date::date
ORDER BY es.user_id ASC, es.start_date ASC;

-- name: ListOverlappingStates :many
SELECT es.id, es.user_id, es.start_date, es.end_date, es.state_id
FROM user_states es
WHERE es.user_id = @user_id::bigint
	AND es.end_date >= @start_date::date
	AND es.start_date <= @end_date::date
ORDER BY es.start_date ASC
FOR UPDATE;

-- name: ListOverlappingStatesByState :many
SELECT es.id, es.user_id, es.start_date, es.end_date, es.state_id
FROM user_states es
WHERE es.user_id = @user_id::bigint
	AND es.state_id = @state_id::bigint
	AND es.end_date >= @start_date::date
	AND es.start_date <= @end_date::date
ORDER BY es.start_date ASC
FOR UPDATE;

-- name: DeleteOverlapping :exec
DELETE FROM user_states
WHERE user_id = @user_id::bigint
	AND end_date >= @start_date::date
	AND start_date <= @end_date::date;

-- name: DeleteOverlappingByState :exec
DELETE FROM user_states
WHERE user_id = @user_id::bigint
	AND state_id = @state_id::bigint
	AND end_date >= @start_date::date
	AND start_date <= @end_date::date;

-- name: InsertStateRange :one
INSERT INTO user_states (user_id, state_id, start_date, end_date)
VALUES (@user_id, @state_id, @start_date::date, @end_date::date)
RETURNING *;

-- name: NormalizeUserStates :exec
-- Merges adjacent ranges with the same (user_id, state_id) into continuous ones.
SELECT fn_normalize_user_states();