-- =============================================
-- RBAC REFERENCE DATA (presets, rights matrix, route policies)
-- =============================================
-- The baseline access-control catalog the application needs to run: it is
-- loaded by the authz PolicyStore (rbac_presets / rbac_preset_rules /
-- rbac_route_policies) and published as the Casbin snapshot. The Go engine
-- mirrors the same data (engine.defaultMatrix, engine.defaultRouteSpecs) as
-- the POST /rbac/reset source and as the middleware fallback when the tables
-- are empty or the DB is unreachable, so the two must stay in sync.
--
-- Scopes (a missing row = no access):
--   all      — full access (dp on views; vp on process.view/state.view)
--   own      — owner of the row itself (project for rp; resource/worker for vp)
--   parent   — owner of the immediate parent (management: process — project;
--              tasks/milestones/assignments — process)
--   ancestor — any owner in the ancestor chain (viewing tasks for rp)
--   admin    — a hard bypass in code (ScopeAll), not stored in the DB.

-- =============================================
-- 1. Preset catalog
-- =============================================
INSERT INTO rbac_presets (tag, name, description) VALUES
    ('admin',  'Администратор',     'system administrator — full access (bypass in code)'),
    ('dp',     'Директор проектов', 'project portfolio director'),
    ('rp',     'Руководитель проекта', 'project manager'),
    ('vp',     'Владелец процесса', 'process owner'),
    ('worker', 'Работник',          'worker (no rights yet)')
ON CONFLICT (tag) DO UPDATE
SET name        = EXCLUDED.name,
    description = EXCLUDED.description,
    updated_at  = NOW();

-- =============================================
-- 2. Rights matrix
-- =============================================
INSERT INTO rbac_preset_rules (preset, resource, action, scope) VALUES
    -- projects: dp — all, rp — own (view/edit/delete), rp creates into own ownership
    ('dp', 'project', 'view',   'all'),
    ('rp', 'project', 'view',   'own'),
    ('rp', 'project', 'create', 'own'),
    ('dp', 'project', 'update', 'all'),
    ('rp', 'project', 'update', 'own'),
    ('rp', 'project', 'delete', 'own'),
    -- processes: dp — all, rp — processes of own projects (parent), vp — all (reference only)
    ('dp', 'process', 'view',   'all'),
    ('rp', 'process', 'view',   'parent'),
    ('vp', 'process', 'view',   'all'),
    ('rp', 'process', 'create', 'parent'),
    ('rp', 'process', 'update', 'parent'),
    ('rp', 'process', 'delete', 'parent'),
    -- tasks / milestones / assignments: dp — all, rp — view via the project (ancestor), vp — management within own process (parent)
    ('dp', 'task',   'view',   'all'),
    ('rp', 'task',   'view',   'ancestor'),
    ('vp', 'task',   'view',   'parent'),
    ('vp', 'task',   'create', 'parent'),
    ('vp', 'task',   'update', 'parent'),
    ('vp', 'task',   'delete', 'parent'),
    ('dp', 'milestone',   'view',   'all'),
    ('rp', 'milestone',   'view',   'ancestor'),
    ('vp', 'milestone',   'view',   'parent'),
    ('vp', 'milestone',   'create', 'parent'),
    ('vp', 'milestone',   'update', 'parent'),
    ('vp', 'milestone',   'delete', 'parent'),
    ('dp', 'assignment',  'view',   'all'),
    ('rp', 'assignment',  'view',   'ancestor'),
    ('vp', 'assignment',  'view',   'parent'),
    ('vp', 'assignment',  'create', 'parent'),
    ('vp', 'assignment',  'update', 'parent'),
    ('vp', 'assignment',  'delete', 'parent'),
    -- states (timesheet dictionary): vp — reference only, management — admin only (bypass)
    ('vp', 'state', 'view', 'all'),
    -- timesheet resources: vp — own
    ('vp', 'resource', 'view',   'own'),
    ('vp', 'resource', 'create', 'own'),
    ('vp', 'resource', 'update', 'own'),
    ('vp', 'resource', 'delete', 'own'),
    -- workers: employee creation — admin only (bypass); vp — own subordinates (own)
    ('vp', 'worker', 'view',   'own'),
    ('vp', 'worker', 'update', 'own'),
    ('vp', 'worker', 'delete', 'own'),
    -- user_catalog (virtual resource: user catalog for pickers): dp/rp/vp + admin (bypass)
    ('dp', 'user_catalog', 'view', 'all'),
    ('rp', 'user_catalog', 'view', 'all'),
    ('vp', 'user_catalog', 'view', 'all')
ON CONFLICT (preset, resource, action) DO NOTHING;
    -- comments carry no matrix rows — rights are derived from the parent task
    -- rbac_config (auto-creation / RBAC management): admin only (bypass), no rows

-- =============================================
-- 3. Route policies (name → kind + params)
-- =============================================
INSERT INTO rbac_route_policies (name, kind, params, active) VALUES
    -- ordering (drag & drop) is a parent-scoped update
    ('process.order', 'parent_action', '{"resource":"process","action":"update","parent_resource":"project","parent_from":"project_id"}', TRUE),
    ('task.order',    'parent_action', '{"resource":"task","action":"update","parent_resource":"process","parent_from":"process_id"}', TRUE),
    -- projects
    ('project.list',    'list',   '{"resource":"project","query_key":"owner_id"}', TRUE),
    ('project.view',    'entity', '{"resource":"project","action":"view","owner":"id"}', TRUE),
    ('project.create',  'create', '{"resource":"project","owner_key":"owner_id","default_self":true}', TRUE),
    ('project.update',  'entity', '{"resource":"project","action":"update","owner":"id"}', TRUE),
    ('project.delete',  'entity', '{"resource":"project","action":"delete","owner":"id"}', TRUE),
    -- processes
    ('process.list',    'list',   '{"resource":"process","query_key":"owner_id"}', TRUE),
    ('process.view',    'entity', '{"resource":"process","action":"view","owner":"id"}', TRUE),
    ('process.create',  'create', '{"resource":"process","parent_resource":"project","parent_from":"project_id"}', TRUE),
    ('process.update',  'entity', '{"resource":"process","action":"update","owner":"id"}', TRUE),
    ('process.delete',  'entity', '{"resource":"process","action":"delete","owner":"id"}', TRUE),
    -- tasks
    ('task.list',       'list',   '{"resource":"task","query_key":"owner_id"}', TRUE),
    ('task.view',       'entity', '{"resource":"task","action":"view","owner":"id"}', TRUE),
    ('task.create',     'create', '{"resource":"task","parent_resource":"process","parent_from":"process_id"}', TRUE),
    ('task.update',     'entity', '{"resource":"task","action":"update","owner":"id"}', TRUE),
    ('task.delete',     'entity', '{"resource":"task","action":"delete","owner":"id"}', TRUE),
    -- milestones
    ('milestone.list',    'list',   '{"resource":"milestone","query_key":"owner_id"}', TRUE),
    ('milestone.view',    'entity', '{"resource":"milestone","action":"view","owner":"id"}', TRUE),
    ('milestone.create',  'create', '{"resource":"milestone","parent_resource":"process","parent_from":"process_id"}', TRUE),
    ('milestone.update',  'entity', '{"resource":"milestone","action":"update","owner":"id"}', TRUE),
    ('milestone.delete',  'entity', '{"resource":"milestone","action":"delete","owner":"id"}', TRUE),
    -- assignments: create — cross-entity owner check (kind owner_match)
    ('assignment.list',   'list',   '{"resource":"assignment","query_key":"owner_id"}', TRUE),
    ('assignment.view',   'entity', '{"resource":"assignment","action":"view","owner":"id"}', TRUE),
    ('assignment.create', 'owner_match', '{"resource":"assignment","action":"create","primary_resource":"task","primary_from":"task_id","compare_resource":"resource","compare_from":"resource_id","exempt_roles":["admin"]}', TRUE),
    ('assignment.update', 'entity', '{"resource":"assignment","action":"update","owner":"id"}', TRUE),
    ('assignment.delete', 'entity', '{"resource":"assignment","action":"delete","owner":"id"}', TRUE),
    -- comments: list/create via task.view; delete — author or task update right
    ('task.comment.list',   'entity', '{"resource":"task","action":"view","owner":"id"}', TRUE),
    ('task.comment.create', 'entity', '{"resource":"task","action":"view","owner":"id"}', TRUE),
    ('task.comment.delete', 'author_or', '{"author_resource":"comment","author_id_param":"comment_id","right_resource":"task","right_action":"update"}', TRUE),
    -- workers
    ('worker.list',    'list',   '{"resource":"worker","query_key":"manager_id"}', TRUE),
    ('worker.view',    'entity', '{"resource":"worker","action":"view","owner":"id"}', TRUE),
    ('worker.create',  'create', '{"resource":"worker","owner_key":"manager_id","default_self":true}', TRUE),
    ('worker.update',  'entity', '{"resource":"worker","action":"update","owner":"id"}', TRUE),
    ('worker.delete',  'entity', '{"resource":"worker","action":"delete","owner":"id"}', TRUE),
    -- user catalog (name picker): virtual resource user_catalog
    ('user.picker',    'entity', '{"resource":"user_catalog","action":"view","owner":"none"}', TRUE),
    -- timesheet resources + calendar
    ('resource.list',        'list',   '{"resource":"resource","query_key":"owner_id"}', TRUE),
    ('resource.view',        'entity', '{"resource":"resource","action":"view","owner":"id"}', TRUE),
    ('resource.create',      'create', '{"resource":"resource","owner_key":"owner_id","default_self":true}', TRUE),
    ('resource.update',      'entity', '{"resource":"resource","action":"update","owner":"id"}', TRUE),
    ('resource.delete',      'entity', '{"resource":"resource","action":"delete","owner":"id"}', TRUE),
    ('resource.member-list',   'entity', '{"resource":"resource","action":"view","owner":"id"}', TRUE),
    ('resource.member-add',    'entity', '{"resource":"resource","action":"update","owner":"id"}', TRUE),
    ('resource.member-remove', 'entity', '{"resource":"resource","action":"update","owner":"id"}', TRUE),
    ('calendar.view',      'list',   '{"resource":"resource","query_key":"owner_id"}', TRUE),
    -- states (ownerless dictionary)
    ('state.list',   'entity', '{"resource":"state","action":"view","owner":"none"}', TRUE),
    ('state.view',   'entity', '{"resource":"state","action":"view","owner":"none"}', TRUE),
    ('state.create', 'entity', '{"resource":"state","action":"create","owner":"none"}', TRUE),
    ('state.update', 'entity', '{"resource":"state","action":"update","owner":"none"}', TRUE),
    ('state.delete', 'entity', '{"resource":"state","action":"delete","owner":"none"}', TRUE),
    -- auto-create config + RBAC admin API (virtual resource rbac_config: admin only)
    ('autocreate.list',   'entity', '{"resource":"rbac_config","action":"view","owner":"none"}', TRUE),
    ('autocreate.update', 'entity', '{"resource":"rbac_config","action":"update","owner":"none"}', TRUE),
    ('rbac.manage',       'entity', '{"resource":"rbac_config","action":"view","owner":"none"}', TRUE),
    -- user admin panel (virtual resource user_admin: admin only by default)
    ('user_admin.create', 'entity', '{"resource":"user_admin","action":"create","owner":"none"}', TRUE),
    ('user_admin.update', 'entity', '{"resource":"user_admin","action":"update","owner":"none"}', TRUE),
    ('user_admin.delete', 'entity', '{"resource":"user_admin","action":"delete","owner":"none"}', TRUE),
    -- planning board (list views of project/process/task)
    ('planning.projects',  'list',   '{"resource":"project","query_key":"owner_id"}', TRUE),
    ('planning.processes', 'list',   '{"resource":"process","query_key":"owner_id"}', TRUE),
    ('planning.tasks',     'list',   '{"resource":"task","query_key":"owner_id"}', TRUE),
    -- audit log (virtual resource audit: admin only)
    ('audit.view', 'entity', '{"resource":"audit","action":"view","owner":"none"}', TRUE),
    -- task dependencies (nested under /task/:id: list via view, manage via update)
    ('task.dependency.list',   'entity', '{"resource":"task","action":"view","owner":"id"}', TRUE),
    ('task.dependency.create', 'entity', '{"resource":"task","action":"update","owner":"id"}', TRUE),
    ('task.dependency.update', 'entity', '{"resource":"task","action":"update","owner":"id"}', TRUE),
    ('task.dependency.delete', 'entity', '{"resource":"task","action":"update","owner":"id"}', TRUE)
ON CONFLICT (name) DO NOTHING;