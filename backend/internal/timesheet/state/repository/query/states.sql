-- name: ListStates :many
SELECT * FROM states
ORDER BY id ASC;

-- name: FindState :one
SELECT * FROM states
WHERE id = @state_id::bigint;

-- name: CreateState :one
-- Idempotent create by business key code: if the code already exists we
-- insert nothing; the calling code (repository) turns the conflict into 409.
INSERT INTO states (code, name, is_available, color)
VALUES (@code, @name, @is_available, @color)
ON CONFLICT ON CONSTRAINT states_code_key
DO NOTHING
RETURNING *;

-- name: UpdateState :one
UPDATE states
SET
	code = @code,
	name = @name,
	is_available = @is_available,
	color = @color,
	updated_at = NOW()
WHERE id = @state_id
RETURNING *;

-- name: DeleteState :exec
DELETE FROM states
WHERE id = @state_id;