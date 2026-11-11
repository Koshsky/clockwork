-- =============================================
-- ARCHIVE-BASED SOFT DELETE
-- =============================================
-- Soft delete is implemented by moving the row: BEFORE DELETE inserts the
-- row into the per-table <table>_deleted archive (V1) and the DELETE then
-- really removes it from the live table. The live tables hold active rows
-- only, so no deleted_at column, no cascade-soft-delete UPDATE triggers and
-- no hard-DELETE blocks are needed — FK ON DELETE CASCADE deletes the whole
-- subtree and every child archives itself through its own trigger.
--
-- Tables WITHOUT deleted_at (user_states, resource_members, refresh_sessions,
-- idempotency_keys, project_auto_create) stay hard-deleted as before.

CREATE OR REPLACE FUNCTION fn_archive_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	cols  TEXT;
	exprs TEXT;
BEGIN
	-- Column list of the live table (identical names in the archive).
	SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum),
	       string_agg('($1).' || quote_ident(a.attname), ', ' ORDER BY a.attnum)
	INTO cols, exprs
	FROM pg_catalog.pg_attribute a
	WHERE a.attrelid = TG_RELID
	  AND a.attnum > 0
	  AND NOT a.attisdropped;

	EXECUTE format(
		'INSERT INTO %I (%s, deleted_at) SELECT %s, NOW()',
		TG_TABLE_NAME || '_deleted', cols, exprs
	) USING OLD;

	RETURN OLD;
END;
$$;

-- One archive trigger per soft-deletable table (mirrors the archive tables
-- declared in V1).
CREATE TRIGGER trg_archive_rbac_presets
BEFORE DELETE ON rbac_presets
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_users
BEFORE DELETE ON users
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_projects
BEFORE DELETE ON projects
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_processes
BEFORE DELETE ON processes
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_tasks
BEFORE DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_resources
BEFORE DELETE ON resources
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_states
BEFORE DELETE ON states
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_assignments
BEFORE DELETE ON assignments
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_milestones
BEFORE DELETE ON milestones
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_task_comments
BEFORE DELETE ON task_comments
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_task_dependencies
BEFORE DELETE ON task_dependencies
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_rbac_preset_rules
BEFORE DELETE ON rbac_preset_rules
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_user_permissions
BEFORE DELETE ON user_permissions
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();

CREATE TRIGGER trg_archive_rbac_route_policies
BEFORE DELETE ON rbac_route_policies
FOR EACH ROW EXECUTE FUNCTION fn_archive_row();