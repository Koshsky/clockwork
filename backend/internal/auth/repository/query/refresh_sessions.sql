-- Check: whether the token is considered active (revoked_at IS NULL AND expires_at > NOW()).
-- name: FindActiveSession :one
SELECT id, user_id, token_hash, created_at, expires_at, revoked_at, COALESCE(replaced_by, 0)::bigint AS replaced_by
FROM refresh_sessions
WHERE token_hash = @token_hash::text
  AND revoked_at IS NULL
  AND expires_at > NOW()
LIMIT 1;

-- Find a session by hash (including revoked/expired ones — to detect token reuse).
-- name: FindSessionByHash :one
SELECT id, user_id, token_hash, created_at, expires_at, revoked_at, COALESCE(replaced_by, 0)::bigint AS replaced_by
FROM refresh_sessions
WHERE token_hash = @token_hash::text
LIMIT 1;

-- Find the session that replaced the given one (the next link of the rotation
-- chain). Used to distinguish a benign concurrent refresh — the presented
-- token was rotated away and its chain still resolves to a live session —
-- from genuine token theft.
-- name: FindSessionByReplacedBy :one
SELECT id, user_id, token_hash, created_at, expires_at, revoked_at, COALESCE(replaced_by, 0)::bigint AS replaced_by
FROM refresh_sessions
WHERE replaced_by = @id::bigint
ORDER BY id
LIMIT 1;

-- name: CreateSession :one
INSERT INTO refresh_sessions (user_id, token_hash, expires_at, replaced_by)
VALUES (@user_id::bigint, @token_hash::text, @expires_at, @replaced_by)
RETURNING id, user_id, token_hash, created_at, expires_at, revoked_at, COALESCE(replaced_by, 0)::bigint AS replaced_by;

-- name: RevokeSession :exec
UPDATE refresh_sessions
SET revoked_at = NOW()
WHERE id = @id::bigint
  AND revoked_at IS NULL;

-- name: RevokeAllUserSessions :exec
UPDATE refresh_sessions
SET revoked_at = NOW()
WHERE user_id = @user_id::bigint
  AND revoked_at IS NULL;

-- name: DeleteExpiredSessions :exec
DELETE FROM refresh_sessions
WHERE expires_at < @older_than::timestamptz;