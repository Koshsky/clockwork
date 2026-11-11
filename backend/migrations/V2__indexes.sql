-- =============================================
-- 1. UNIQUE INDICES
-- Deleted rows are physically moved to the *_deleted archives (V5), so the
-- live tables hold active rows only and the unique indexes are plain
-- (no partial predicates, no deleted_at).
-- =============================================
CREATE UNIQUE INDEX idx_users_username ON users(username);
CREATE UNIQUE INDEX idx_projects_code ON projects(code);
CREATE UNIQUE INDEX idx_resources_title ON resources(title);
CREATE UNIQUE INDEX idx_resources_code ON resources(code);
CREATE UNIQUE INDEX idx_assignments_unique
ON assignments(task_id, resource_id);
-- Order uniqueness within the parent group (freed when a row is deleted).
-- Tasks: top-level tasks (parent_id IS NULL → COALESCE 0) stay unique within
-- their process, subtasks within their parent task. A subtask's process_id
-- always equals its parent's (enforced in the service), so one index covers
-- both levels.
CREATE UNIQUE INDEX idx_processes_project_sort_order
ON processes(project_id, sort_order);
CREATE UNIQUE INDEX idx_tasks_parent_sort_order
ON tasks(process_id, COALESCE(parent_id, 0), sort_order);
-- Per-user permission overrides: one (resource, action) pair per user;
-- replacing the set deletes (archives) the previous rows first.
CREATE UNIQUE INDEX idx_user_permissions_unique
ON user_permissions(user_id, resource, action);

-- =============================================
-- 2. INDICES FOR Foreign Keys
-- =============================================
CREATE INDEX idx_processes_project_id ON processes(project_id);
CREATE INDEX idx_tasks_process_id ON tasks(process_id);
-- FK lookup for subtasks (top-level tasks have no parent).
CREATE INDEX idx_tasks_parent_id ON tasks(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX idx_assignments_task_id ON assignments(task_id);
CREATE INDEX idx_assignments_resource_id ON assignments(resource_id);
CREATE INDEX idx_milestones_process_id ON milestones(process_id);
CREATE INDEX idx_users_manager_id ON users(manager_id);
CREATE INDEX idx_user_states_user_id ON user_states(user_id);

-- =============================================
-- 3. INDICES FOR dates
-- =============================================
CREATE INDEX idx_user_states_dates ON user_states (start_date, end_date);
CREATE INDEX idx_tasks_dates ON tasks(start_date, end_date);
CREATE INDEX idx_milestones_date ON milestones(date);

-- =============================================
-- 4. INDICES FOR auth / idempotency / comments
-- =============================================
CREATE INDEX refresh_sessions_user_idx    ON refresh_sessions (user_id);
CREATE INDEX refresh_sessions_expires_idx ON refresh_sessions (expires_at);
CREATE INDEX idx_idempotency_keys_expires ON idempotency_keys (expires_at);
CREATE INDEX idx_task_comments_task_id ON task_comments(task_id);
CREATE INDEX idx_task_comments_task_created ON task_comments(task_id, created_at);
CREATE INDEX idx_task_comments_parent_id ON task_comments(parent_id) WHERE parent_id IS NOT NULL;

-- =============================================
-- 5. INDICES FOR task dependencies
-- =============================================
-- Successor lookup (incoming constraints of a task) and cascade scans.
CREATE INDEX idx_task_dependencies_task ON task_dependencies(task_id);
CREATE INDEX idx_task_dependencies_depends_on ON task_dependencies(depends_on_task_id);