-- Add the accountable person (responsible) to projects, processes and tasks.
-- responsible_id is a display/accountability field only — it does NOT
-- participate in RBAC (owner_id remains the ownership axis, unchanged).
-- V1 (the sqlc schema source) is frozen after deployment, so the columns land
-- here; the project/process/task/planning sqlc.yaml files reference this file
-- in addition to V1 so generated models pick the columns up.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT REFERENCES users(id);

ALTER TABLE projects_deleted
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT;

ALTER TABLE processes
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT REFERENCES users(id);

ALTER TABLE processes_deleted
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT;

ALTER TABLE tasks
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT REFERENCES users(id);

ALTER TABLE tasks_deleted
    ADD COLUMN IF NOT EXISTS responsible_id BIGINT;

-- Data migration: backfill the task responsible from the current owner
-- (historically the executor/assignee). owner_id is left untouched — RBAC
-- keeps reading it. The guard makes the statement idempotent: a second run
-- never overwrites an already-set responsible_id.
UPDATE tasks
SET responsible_id = owner_id
WHERE owner_id IS NOT NULL
  AND responsible_id IS NULL;
