-- Preserve the priority capability previously included in project.update.
-- Personal grants and revokes retain precedence over preset rules.
INSERT INTO rbac_preset_rules(preset, resource, action, scope, updated_by)
SELECT preset, resource, 'prioritize', scope, updated_by FROM rbac_preset_rules
WHERE resource = 'project' AND action = 'update' AND preset NOT IN ('dp','rp','vp','worker')
ON CONFLICT (preset, resource, action) DO NOTHING;

INSERT INTO user_permissions(user_id, resource, action, scope, granted, updated_by)
SELECT user_id, resource, 'prioritize', scope, granted, updated_by FROM user_permissions
WHERE resource = 'project' AND action = 'update'
ON CONFLICT (user_id, resource, action) DO NOTHING;

-- Only existing predefined tags are upgraded; renamed and deleted roles stay untouched.
DELETE FROM rbac_preset_rules WHERE preset IN ('dp','rp','vp','worker');
INSERT INTO rbac_preset_rules(preset, resource, action, scope)
SELECT rules.* FROM (VALUES
    ('dp', 'project', 'view', 'all'),
    ('rp', 'project', 'view', 'self'),
    ('rp', 'project', 'create', 'self'),
    ('rp', 'project', 'update', 'self'),
    ('rp', 'project', 'delete', 'self'),
    ('dp', 'process', 'view', 'all'),
    ('rp', 'process', 'view', 'project_owner'),
    ('rp', 'process', 'create', 'project_owner'),
    ('rp', 'process', 'update', 'project_owner'),
    ('rp', 'process', 'delete', 'project_owner'),
    ('vp', 'process', 'view', 'process_owner'),
    ('vp', 'process', 'create', 'process_owner'),
    ('vp', 'process', 'update', 'process_owner'),
    ('vp', 'process', 'delete', 'process_owner'),
    ('dp', 'task', 'view', 'all'),
    ('rp', 'task', 'view', 'project_owner'),
    ('rp', 'task', 'create', 'project_owner'),
    ('rp', 'task', 'update', 'project_owner'),
    ('rp', 'task', 'delete', 'project_owner'),
    ('vp', 'task', 'view', 'process_owner'),
    ('vp', 'task', 'create', 'process_owner'),
    ('vp', 'task', 'update', 'process_owner'),
    ('vp', 'task', 'delete', 'process_owner'),
    ('dp', 'milestone', 'view', 'all'),
    ('rp', 'milestone', 'view', 'project_owner'),
    ('rp', 'milestone', 'create', 'project_owner'),
    ('rp', 'milestone', 'update', 'project_owner'),
    ('rp', 'milestone', 'delete', 'project_owner'),
    ('vp', 'milestone', 'view', 'process_owner'),
    ('vp', 'milestone', 'create', 'process_owner'),
    ('vp', 'milestone', 'update', 'process_owner'),
    ('vp', 'milestone', 'delete', 'process_owner'),
    ('dp', 'assignment', 'view', 'all'),
    ('rp', 'assignment', 'view', 'project_owner'),
    ('rp', 'assignment', 'create', 'project_owner'),
    ('rp', 'assignment', 'update', 'project_owner'),
    ('rp', 'assignment', 'delete', 'project_owner'),
    ('vp', 'assignment', 'view', 'process_owner'),
    ('vp', 'assignment', 'create', 'process_owner'),
    ('vp', 'assignment', 'update', 'process_owner'),
    ('vp', 'assignment', 'delete', 'process_owner'),
    ('dp', 'project', 'prioritize', 'all'),
    ('rp', 'project', 'prioritize', 'self'),
    ('vp', 'project', 'view', 'process_projects'),
    ('dp', 'resource', 'view', 'all'),
    ('rp', 'resource', 'view', 'self project_resources'),
    ('vp', 'resource', 'view', 'self'),
    ('vp', 'resource', 'create', 'self'),
    ('vp', 'resource', 'update', 'self'),
    ('vp', 'resource', 'delete', 'self'),
    ('vp', 'state', 'view', 'all'),
    ('vp', 'worker', 'view', 'self'),
    ('vp', 'worker', 'update', 'self'),
    ('vp', 'worker', 'delete', 'self'),
    ('dp', 'user_catalog', 'view', 'all'),
    ('rp', 'user_catalog', 'view', 'all'),
    ('vp', 'user_catalog', 'view', 'all')
) AS rules(preset, resource, action, scope)
JOIN rbac_presets catalog ON catalog.tag = rules.preset;
