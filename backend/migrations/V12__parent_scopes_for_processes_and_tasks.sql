-- Existing grants follow parent ownership instead of the process/task row owner.
UPDATE rbac_preset_rules
SET scope = regexp_replace(scope, '\m(self|own)\M', 'up1', 'g'), updated_at = NOW()
WHERE resource IN ('process', 'task') AND scope ~ '\m(self|own)\M';

UPDATE user_permissions
SET scope = regexp_replace(scope, '\m(self|own)\M', 'up1', 'g'), updated_at = NOW()
WHERE resource IN ('process', 'task') AND scope ~ '\m(self|own)\M';
