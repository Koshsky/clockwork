-- name: CreateComment :one
INSERT INTO task_comments (task_id, author_id, parent_id, content)
VALUES (@task_id, @author_id, @parent_id, @content)
RETURNING *;

-- name: ListComments :many
SELECT *
FROM task_comments
WHERE task_id = @task_id::bigint
ORDER BY created_at ASC, id ASC;

-- name: FindComment :one
SELECT *
FROM task_comments
WHERE id = @comment_id::bigint;

-- name: DeleteComment :exec
DELETE FROM task_comments
WHERE id = @comment_id::bigint;

-- name: OwnerChain :one
SELECT COALESCE(pr.owner_id, 0)::bigint AS project_owner,
       COALESCE(p.owner_id, 0)::bigint  AS process_owner,
       tc.author_id                      AS author
FROM task_comments tc
JOIN tasks t ON t.id = tc.task_id
JOIN processes p ON p.id = t.process_id
JOIN projects pr ON pr.id = p.project_id
WHERE tc.id = @id::bigint;