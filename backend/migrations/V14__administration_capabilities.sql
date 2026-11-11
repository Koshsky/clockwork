-- Preserve effective legacy capabilities before separating their meanings.
CREATE TEMP TABLE administration_legacy_roles ON COMMIT DROP AS
SELECT * FROM rbac_preset_rules WHERE resource IN ('rbac_config', 'state_admin');
CREATE TEMP TABLE administration_legacy_users ON COMMIT DROP AS
SELECT * FROM user_permissions WHERE resource IN ('rbac_config', 'state_admin');

-- RBAC view already authorized every RBAC mutation. Its old update action
-- authorized only template writes and must never become an RBAC grant.
DELETE FROM rbac_preset_rules WHERE resource IN ('rbac_config', 'state_admin');
DELETE FROM user_permissions WHERE resource IN ('rbac_config', 'state_admin');
INSERT INTO rbac_preset_rules (preset, resource, action, scope, updated_by)
SELECT preset, 'rbac_config', 'update', scope, updated_by
FROM administration_legacy_roles WHERE resource = 'rbac_config' AND action = 'view';
INSERT INTO user_permissions (user_id, resource, action, scope, granted, updated_by)
SELECT user_id, 'rbac_config', 'update', scope, granted, updated_by
FROM administration_legacy_users WHERE resource = 'rbac_config' AND action = 'view';

-- Read-only template access stays read-only, including individual revokes.
INSERT INTO rbac_preset_rules (preset, resource, action, scope, updated_by)
SELECT preset, 'auto_create', action, scope, updated_by
FROM administration_legacy_roles WHERE resource = 'rbac_config' AND action IN ('view', 'update')
ON CONFLICT (preset, resource, action) DO NOTHING;
INSERT INTO user_permissions (user_id, resource, action, scope, granted, updated_by)
SELECT user_id, 'auto_create', action, scope, granted, updated_by
FROM administration_legacy_users WHERE resource = 'rbac_config' AND action IN ('view', 'update')
ON CONFLICT (user_id, resource, action) DO NOTHING;

-- The page and its dictionary share one view permission; an existing
-- dictionary rule or explicit denial retains precedence over the old page flag.
INSERT INTO rbac_preset_rules (preset, resource, action, scope, updated_by)
SELECT preset, 'state', 'view', scope, updated_by
FROM administration_legacy_roles WHERE resource = 'state_admin' AND action = 'view'
ON CONFLICT (preset, resource, action) DO NOTHING;
INSERT INTO user_permissions (user_id, resource, action, scope, granted, updated_by)
SELECT user_id, 'state', 'view', scope, granted, updated_by
FROM administration_legacy_users WHERE resource = 'state_admin' AND action = 'view'
ON CONFLICT (user_id, resource, action) DO NOTHING;

UPDATE rbac_route_policies SET params = jsonb_set(params, '{action}', '"update"'), updated_at = NOW()
WHERE name = 'rbac.manage' AND kind = 'entity' AND params->>'resource' = 'rbac_config' AND params->>'action' = 'view';
UPDATE rbac_route_policies SET params = jsonb_set(params, '{resource}', '"auto_create"'), updated_at = NOW()
WHERE name = 'autocreate.update' AND kind = 'entity' AND params->>'resource' = 'rbac_config';
UPDATE rbac_route_policies SET kind = 'any_capability',
    params = '{"permissions":["auto_create/view","auto_create/update"]}', updated_at = NOW()
WHERE name = 'autocreate.list' AND kind = 'entity' AND params->>'resource' = 'rbac_config' AND params->>'action' = 'view';
INSERT INTO rbac_route_policies (name, kind, params) VALUES
    ('user.accounts', 'any_capability', '{"permissions":["user_admin/view","rbac_config/update"]}'),
    ('user.structure', 'entity', '{"resource":"org_structure","action":"view","owner":"none"}')
ON CONFLICT (name) DO NOTHING;

-- Remove inoperative legacy settings from the editable permission catalog.
DELETE FROM rbac_preset_rules
WHERE resource IN ('user_catalog','org_structure','audit') AND action <> 'view';
DELETE FROM user_permissions
WHERE resource IN ('user_catalog','org_structure','audit') AND action <> 'view';
