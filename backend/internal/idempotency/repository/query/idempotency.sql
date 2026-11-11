-- name: CreateIdempotencyKey :one
INSERT INTO idempotency_keys (key, user_id, method, path, expires_at)
VALUES (@key, @user_id::bigint, @method, @path, @expires_at::timestamptz)
ON CONFLICT (key, user_id, method, path) DO NOTHING
RETURNING *;

-- name: GetIdempotencyKey :one
SELECT *
FROM idempotency_keys
WHERE key = @key
	AND user_id = @user_id::bigint
	AND method = @method
	AND path = @path;

-- name: CompleteIdempotencyKey :exec
UPDATE idempotency_keys
SET response_status = @response_status::int,
    response_body   = @response_body::jsonb
WHERE key = @key
	AND user_id = @user_id::bigint
	AND method = @method
	AND path = @path;

-- name: DeleteIdempotencyKey :exec
DELETE FROM idempotency_keys
WHERE key = @key
	AND user_id = @user_id::bigint
	AND method = @method
	AND path = @path;

-- name: DeleteExpiredIdempotencyKeys :exec
DELETE FROM idempotency_keys
WHERE expires_at < NOW();
