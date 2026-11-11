-- Initial schema for enterprise resource planning.
-- Complete schema: all tables are created once, all CHECK/FK constraints
-- are declared inline. No subsequent ALTER TABLE is required.

-- The user_states EXCLUDE constraint relies on btree_gist.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- =============================================
-- Permission presets (renamed from the RBAC role catalog): a named set of
-- permissions assigned as the base rights of a user.
-- Created before users: users.preset references rbac_presets(tag).
-- =============================================
CREATE TABLE rbac_presets (
    id          BIGSERIAL PRIMARY KEY,
    -- tag: system access code (admin/dp/rp/vp/worker/custom preset) — the
    -- unique identity of the preset, stored as a value in users.preset and
    -- rbac_preset_rules.preset (no FK — integrity is enforced by the RBAC
    -- service, catalog rows are mutable).
    tag         TEXT NOT NULL UNIQUE,
    -- name: human-readable display name.
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- People (a single table). A worker is a user with the worker preset; the worker's
-- profile (position, dates, manager) is stored directly on users.
CREATE TABLE users (
	id BIGSERIAL PRIMARY KEY,
	last_name TEXT NOT NULL,
	first_name TEXT NOT NULL,
	-- Patronymic is optional.
	middle_name TEXT DEFAULT NULL,
	-- Base permission preset from the rbac_presets catalog (admin/dp/rp/vp/worker
	-- + runtime presets); NULL — no base rights (only individual user_permissions).
	-- Holds the preset TAG (system access code) as a value, no FK.
	preset TEXT,
	username TEXT NOT NULL,
	password_hash TEXT NOT NULL,
	-- The worker's manager (a user with the vp role); NULL for other roles.
	manager_id BIGINT REFERENCES users(id),
	-- Position is free text (not a resource type).
	position TEXT NOT NULL DEFAULT '',
	-- NULL means "on staff since the beginning of time"; before hire_date the worker is not counted.
	hire_date DATE DEFAULT NULL,
	-- NULL means "still employed"; after termination_date the worker is not counted.
	termination_date DATE DEFAULT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (termination_date IS NULL OR hire_date IS NULL OR termination_date >= hire_date)
);

CREATE TABLE projects (
	id BIGSERIAL PRIMARY KEY,
	owner_id BIGINT REFERENCES users(id),
	code TEXT NOT NULL,
	-- Optional entity color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	priority INTEGER NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (end_date >= start_date),
	CHECK (priority >= 0)
);

CREATE TABLE processes (
	id BIGSERIAL PRIMARY KEY,
	project_id BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	owner_id BIGINT REFERENCES users(id),
	title TEXT NOT NULL,
	-- Optional entity color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	-- Order of the process within its project (unique per project, see V2). 
	-- Ascending display order; a distinct order column (not id) so rows can be
	-- reordered without rewriting their identity.
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (end_date >= start_date)
);

CREATE TABLE tasks (
	id BIGSERIAL PRIMARY KEY,
	process_id BIGINT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
	-- Subtask (operation) link: the parent task this task is attached to.
	-- NULL — a top-level task of its process. The process_id always matches
	-- the parent's process (enforced in the service), so RBAC stays unchanged.
	parent_id BIGINT REFERENCES tasks(id) ON DELETE CASCADE,
	owner_id BIGINT REFERENCES users(id),
	title TEXT NOT NULL,
	-- Optional entity color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	-- Execution status of the task (fixed catalog).
	status TEXT NOT NULL DEFAULT 'not_started',
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	-- Order of the task within its parent group (unique per parent group via
	-- idx_tasks_parent_sort_order, see V16): top-level tasks sort within the
	-- process, subtasks within the parent task.
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (end_date >= start_date),
	CHECK (status IN ('not_started', 'in_progress', 'done'))
);

-- Scheduling dependency between two top-level tasks of the same process
-- (enforced in the service): the successor (task_id) cannot start/finish
-- before the predecessor (depends_on_task_id) — the exact rule depends on the
-- link type (fs/ss/ff/sf). Row deletion is move-to-archive (V5 trigger).
CREATE TABLE task_dependencies (
	id BIGSERIAL PRIMARY KEY,
	-- Dependent task (successor) of the link.
	task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	-- Predecessor task of the link.
	depends_on_task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	-- Dependency type catalog:
	--   fs — finish-to-start:  task must start after the predecessor ends,
	--   ss — start-to-start:   task must start after the predecessor starts,
	--   ff — finish-to-finish: task must end after the predecessor ends,
	--   sf — start-to-finish:  task must end after the predecessor starts.
	type TEXT NOT NULL DEFAULT 'fs',
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CONSTRAINT task_dependencies_no_self CHECK (task_id <> depends_on_task_id),
	CONSTRAINT task_dependencies_unique UNIQUE (task_id, depends_on_task_id),
	CHECK (type IN ('fs', 'ss', 'ff', 'sf'))
);

-- Resource category dictionary (specializations).
CREATE TABLE resources (
	id BIGSERIAL PRIMARY KEY,
	title TEXT NOT NULL,
	code TEXT NOT NULL,
	-- Optional resource color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	-- Resource owner (user account) is required.
	owner_id BIGINT NOT NULL REFERENCES users(id),
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (length(trim(code)) > 0)
);

-- Employee state dictionary: availability is set by the is_available flag.
CREATE TABLE states (
	id BIGSERIAL PRIMARY KEY,
	code TEXT NOT NULL UNIQUE,
	name TEXT NOT NULL,
	is_available BOOLEAN NOT NULL DEFAULT TRUE,
	-- Optional state color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Worker states (absence only): one row = interval [start_date, end_date].
-- Missing rows mean present; rows are hard-deleted (audit log).
-- The EXCLUDE constraint forbids overlapping states per worker (one state per day).
CREATE TABLE user_states (
	id BIGSERIAL PRIMARY KEY,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	state_id BIGINT NOT NULL REFERENCES states(id) ON DELETE RESTRICT,
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (end_date >= start_date),
	EXCLUDE USING gist (
		user_id WITH =,
		daterange(start_date, end_date, '[]') WITH &&
	)
);

-- Resource user list: the resource enumerates its workers.
-- UNIQUE(user_id) — a worker belongs to at most one resource; membership is optional.
CREATE TABLE resource_members (
	resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	PRIMARY KEY (resource_id, user_id),
	UNIQUE (user_id)
);

CREATE TABLE assignments (
	id BIGSERIAL PRIMARY KEY,
	task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	resource_id BIGINT NOT NULL REFERENCES resources(id) ON DELETE RESTRICT,
	quantity INTEGER NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	CHECK (quantity > 0)
);

CREATE TABLE milestones (
	id BIGSERIAL PRIMARY KEY,
	process_id BIGINT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	-- Optional entity color (#RRGGBB, NULL — standard color on the frontend).
	color TEXT,
	date DATE NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-creation config for processes/tasks on project insert (V8).
CREATE TABLE project_auto_create (
	id BIGSERIAL PRIMARY KEY,
	enabled BOOLEAN NOT NULL DEFAULT TRUE,
	config JSONB NOT NULL DEFAULT '[]'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Server-side refresh sessions (refresh-token rotation/revocation).
-- Only the SHA-256 of the token is stored; the opaque token lives in an HttpOnly cookie.
CREATE TABLE refresh_sessions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT NOT NULL UNIQUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL,
    revoked_at  TIMESTAMPTZ,
    -- Rotation chain: id of the session this one replaced (to detect reuse).
    replaced_by BIGINT REFERENCES refresh_sessions(id)
);

-- Idempotency keys: idempotent create endpoints.
-- PK (key, user_id, method, path): isolation per client/route.
CREATE TABLE idempotency_keys (
    key             TEXT NOT NULL,
    user_id         BIGINT NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    response_status INTEGER NOT NULL DEFAULT 0,
    response_body   JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at      TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (key, user_id, method, path)
);

-- Task comments: discussion threads (replies to replies via parent_id).
CREATE TABLE task_comments (
	id BIGSERIAL PRIMARY KEY,
	task_id BIGINT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	-- Comment author (taken from the auth context).
	author_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
	-- Reply to another comment on the same task; NULL — a root comment.
	parent_id BIGINT REFERENCES task_comments(id) ON DELETE CASCADE,
	content TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The rights matrix (rbac_preset_rules) and route-policy definitions
-- (rbac_route_policies) are configured at runtime: the source of truth is the DB,
-- while the engine (scope interpretation, kind registry) stays in code.
CREATE TABLE rbac_preset_rules (
    id          BIGSERIAL PRIMARY KEY,
    -- preset: tag of the preset from the rbac_presets catalog (no FK —
    -- integrity is enforced by the RBAC service).
    preset      TEXT NOT NULL,
    resource    TEXT NOT NULL, -- project|process|task|milestone|assignment|state|resource|worker|comment|user_catalog|rbac_config
    action      TEXT NOT NULL, -- view|create|update|delete
    scope       TEXT NOT NULL, -- all|own|parent|ancestor
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  BIGINT,        -- user who made the last change (from JWT)
    UNIQUE (preset, resource, action)
);

-- Per-user permission overrides: an explicit grant (granted=true, scope) or
-- revoke (granted=false, scope ignored) that shadows the preset rule for the
-- same (resource, action); no row — fall back to the assigned preset.
-- Deleted (archived) on replacement; unique per (user_id, resource, action).
CREATE TABLE user_permissions (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    resource    TEXT NOT NULL, -- same resource codes as rbac_preset_rules
    action      TEXT NOT NULL, -- same action codes as rbac_preset_rules
    -- Scope EXPRESSION over the ownership tree (all|self|up1|up|sib|down|…
    -- and combos like "self sib"); legacy codes (own|parent|ancestor) are
    -- canonicalized on save. Syntax is validated by the RBAC service.
    scope       TEXT NOT NULL DEFAULT 'all',
    granted     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  BIGINT,        -- user who made the last change (from JWT)
    CHECK (NOT granted OR length(trim(scope)) > 0)
);

CREATE TABLE rbac_route_policies (
    name        TEXT PRIMARY KEY,  -- name routes reference (mw.Check("project.create"))
    kind        TEXT NOT NULL,     -- list|entity|create|owner_match|author_or|parent_action
    params      JSONB NOT NULL,    -- kind params (schema — the kind registry in code)
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  BIGINT
);

-- =============================================
-- DELETED ROW ARCHIVES (soft delete by move)
-- Every DELETE on an archived table first copies the row here (the generic
-- trigger fn_archive_row, created in V5) and then really removes it from the
-- live table. The archive keeps the same columns as its source table plus a
-- trailing deleted_at (when the row was removed). No FKs/unique/CHECK
-- constraints — an archive is a plain snapshot; the original ids and
-- business keys are preserved as data so a row can be restored later.
-- =============================================

CREATE TABLE rbac_presets_deleted (
    id          BIGINT NOT NULL,
    tag         TEXT NOT NULL DEFAULT '',
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE users_deleted (
    id               BIGINT NOT NULL,
    last_name        TEXT NOT NULL,
    first_name       TEXT NOT NULL,
    middle_name      TEXT,
    preset           TEXT,
    username         TEXT NOT NULL,
    password_hash    TEXT NOT NULL,
    manager_id       BIGINT,
    position         TEXT NOT NULL DEFAULT '',
    hire_date        DATE,
    termination_date DATE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE projects_deleted (
    id         BIGINT NOT NULL,
    owner_id   BIGINT,
    code       TEXT NOT NULL,
    color      TEXT,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    priority   INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE processes_deleted (
    id         BIGINT NOT NULL,
    project_id BIGINT NOT NULL,
    owner_id   BIGINT,
    title      TEXT NOT NULL,
    color      TEXT,
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tasks_deleted (
    id         BIGINT NOT NULL,
    process_id BIGINT NOT NULL,
    parent_id  BIGINT,
    owner_id   BIGINT,
    title      TEXT NOT NULL,
    color      TEXT,
    status     TEXT NOT NULL DEFAULT 'not_started',
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_dependencies_deleted (
    id                  BIGINT NOT NULL,
    task_id             BIGINT NOT NULL,
    depends_on_task_id  BIGINT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'fs',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE resources_deleted (
    id         BIGINT NOT NULL,
    title      TEXT NOT NULL,
    code       TEXT NOT NULL,
    color      TEXT,
    owner_id   BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE states_deleted (
    id           BIGINT NOT NULL,
    code         TEXT NOT NULL,
    name         TEXT NOT NULL,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    color        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE assignments_deleted (
    id          BIGINT NOT NULL,
    task_id     BIGINT NOT NULL,
    resource_id BIGINT NOT NULL,
    quantity    INTEGER NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE milestones_deleted (
    id         BIGINT NOT NULL,
    process_id BIGINT NOT NULL,
    title      TEXT NOT NULL,
    content    TEXT NOT NULL,
    color      TEXT,
    date       DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE task_comments_deleted (
    id         BIGINT NOT NULL,
    task_id    BIGINT NOT NULL,
    author_id  BIGINT NOT NULL,
    parent_id  BIGINT,
    content    TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE rbac_preset_rules_deleted (
    id         BIGINT NOT NULL,
    preset     TEXT NOT NULL,
    resource   TEXT NOT NULL,
    action     TEXT NOT NULL,
    scope      TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by BIGINT
);

CREATE TABLE user_permissions_deleted (
    id         BIGINT NOT NULL,
    user_id    BIGINT NOT NULL,
    resource   TEXT NOT NULL,
    action     TEXT NOT NULL,
    scope      TEXT NOT NULL DEFAULT 'all',
    granted    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by BIGINT
);

CREATE TABLE rbac_route_policies_deleted (
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    params      JSONB NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by  BIGINT
);