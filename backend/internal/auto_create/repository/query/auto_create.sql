-- name: GetAutoCreateConfig :one
SELECT id, enabled, config
FROM project_auto_create
ORDER BY id
LIMIT 1;

-- name: UpsertAutoCreateConfig :one
INSERT INTO project_auto_create (id, enabled, config)
VALUES (1, @enabled, @config::jsonb)
ON CONFLICT (id) DO UPDATE
SET enabled = EXCLUDED.enabled,
    config = EXCLUDED.config,
    updated_at = NOW()
RETURNING *;

-- name: ListExistingResources :many
SELECT id
FROM resources
WHERE id = ANY(@ids::bigint[]);

-- name: ListExistingUsers :many
SELECT id
FROM users
WHERE id = ANY(@ids::bigint[]);