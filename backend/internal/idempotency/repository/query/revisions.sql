-- name: LockRevisionWriters :exec
SELECT pg_advisory_xact_lock(718226341);

-- name: ListOperationRevisions :many
SELECT key, revision::text AS revision FROM operation_revisions WHERE key = ANY($1::text[]);

-- name: RevisionProcessProject :one
SELECT project_id FROM processes WHERE id = $1;

-- name: RevisionTaskProcess :one
SELECT process_id FROM tasks WHERE id = $1;

-- name: RevisionMilestoneProcess :one
SELECT process_id FROM milestones WHERE id = $1;

-- name: RevisionAssignmentParents :one
SELECT t.process_id, a.resource_id FROM assignments a JOIN tasks t ON t.id = a.task_id WHERE a.id = $1;
