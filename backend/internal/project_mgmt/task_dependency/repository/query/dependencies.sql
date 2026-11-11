-- name: CreateDependency :one
INSERT INTO task_dependencies (task_id, depends_on_task_id, type)
VALUES (@task_id, @depends_on_task_id, @type)
RETURNING *;

-- name: ListDependenciesByTask :many
-- Incoming links of a task (its predecessors), in creation order.
SELECT *
FROM task_dependencies
WHERE task_id = @task_id::bigint
ORDER BY id ASC;

-- name: FindDependency :one
SELECT *
FROM task_dependencies
WHERE id = @id::bigint;

-- name: UpdateDependencyType :one
UPDATE task_dependencies
SET type = @type, updated_at = NOW()
WHERE id = @id
RETURNING *;

-- name: DeleteDependency :exec
DELETE FROM task_dependencies
WHERE id = @id;

-- name: DependencyExists :one
SELECT EXISTS (
    SELECT 1 FROM task_dependencies
    WHERE task_id = @task_id::bigint
      AND depends_on_task_id = @depends_on_task_id::bigint
);

-- name: ValidateLink :one
-- Both endpoints of a candidate dependency (the dependent task keyed by
-- task_id, the predecessor by depends_on_task_id via LEFT JOIN — pred_id 0
-- means the predecessor is missing). Carries the dates and the parent/process
-- info so the service can enforce "same process + top-level only" and the
-- candidate-edge date check in one round trip.
SELECT
	t.id AS task_id,
	t.title AS task_title,
	t.start_date AS task_start_date,
	t.end_date AS task_end_date,
	t.process_id AS task_process_id,
	(t.parent_id IS NULL)::bool AS task_is_top,
	COALESCE(p.id, 0) AS pred_id,
	COALESCE(p.title, '') AS pred_title,
	COALESCE(p.start_date, '0001-01-01') AS pred_start_date,
	COALESCE(p.end_date, '0001-01-01') AS pred_end_date,
	COALESCE(p.process_id, 0) AS pred_process_id,
	COALESCE(p.parent_id IS NULL, true)::bool AS pred_is_top
FROM tasks t
LEFT JOIN tasks p ON p.id = @depends_on_task_id::bigint
WHERE t.id = @task_id::bigint;

-- name: DependencyCycle :one
-- True when inserting task_id -> depends_on_task_id would close a cycle:
-- the predecessor already (transitively) depends on the dependent task.
-- Walks predecessor links (successor -> predecessor) from the predecessor
-- with a depth cap (a guard against corrupted graphs).
WITH RECURSIVE walk AS (
	SELECT depends_on, 1 AS depth
	FROM (
		SELECT depends_on_task_id AS depends_on
		FROM task_dependencies
		WHERE task_id = @depends_on_task_id::bigint
	) start_edges
	UNION ALL
	SELECT d.depends_on_task_id, w.depth + 1
	FROM walk w
	JOIN task_dependencies d ON d.task_id = w.depends_on
	WHERE w.depth < 100
)
SELECT EXISTS (SELECT 1 FROM walk WHERE depends_on = @task_id::bigint);

-- name: ListTaskConstraints :many
-- Incoming scheduling constraints of a task (the task as a successor): each
-- edge with its type and the predecessor's current dates + display title.
-- Used by the date guard (CheckTaskDates) and by the editor.
SELECT
	td.id,
	td.type,
	p.id AS pred_id,
	p.title AS pred_title,
	p.start_date AS pred_start_date,
	p.end_date AS pred_end_date
FROM task_dependencies td
JOIN tasks p ON p.id = td.depends_on_task_id
WHERE td.task_id = @task_id::bigint
ORDER BY td.id ASC;

-- name: FindTaskDates :one
SELECT start_date, end_date
FROM tasks
WHERE id = @task_id::bigint;