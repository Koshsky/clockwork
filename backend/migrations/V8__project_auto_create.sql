-- =============================================
-- PROJECT AUTO-CREATION TRIGGER
-- =============================================
-- Configurable auto-creation of processes/tasks when a project is inserted
-- (the single-row project_auto_create table lives in V1). The config is a
-- JSONB template:
--   [ { "title": "Инсталляция", "owner_id": 5, "color": "#0D9488", "tasks": [
--       { "title": "Осмотр объекта", "color": "#94A3B8",
--         "resources":  [ { "resource_id": 1, "quantity": 2 } ],
--         "operations": [ { "title": "Подготовка площадки" } ] }, ... ] }, ... ]
--
-- The template array position is written into sort_order (jsonb arrays keep
-- their order; WITH ORDINALITY numbers the elements), so the admin-defined
-- template order is preserved on creation (processes within the project, tasks
-- within the process). A template task's "operations" become subtasks
-- (parent_id = the created task) with status 'not_started'; subtasks have no
-- color and no resources of their own.
--
-- Optional fields are NULL-safe: (value->>'color') is read through
-- NULLIF(..., ''), and empty/missing/JSON-null arrays (resources, operations)
-- are normalized to '[]' — a JSON null would otherwise break
-- jsonb_array_elements and fail the whole project INSERT.
CREATE OR REPLACE FUNCTION fn_project_auto_create() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	cfg     RECORD;
	p       RECORD;
	tk      RECORD;
	op      RECORD;
	pid     BIGINT;
	tid     BIGINT;
BEGIN
	SELECT * INTO cfg FROM project_auto_create ORDER BY id LIMIT 1;
	IF NOT FOUND OR NOT cfg.enabled THEN
		RETURN NEW;
	END IF;

	FOR p IN
		SELECT value->>'title' AS title,
		       (value->>'owner_id')::bigint AS owner_id,
		       value->>'color' AS color,
		       value->'tasks' AS tasks,
		       ord
		FROM jsonb_array_elements(cfg.config) WITH ORDINALITY AS pp(value, ord)
	LOOP
		INSERT INTO processes (project_id, title, start_date, end_date, owner_id, color, sort_order)
		VALUES (NEW.id, p.title, NEW.start_date, NEW.end_date, p.owner_id, NULLIF(p.color, ''), p.ord)
		RETURNING id INTO pid;

		FOR tk IN
			SELECT value, ord
			FROM jsonb_array_elements(p.tasks) WITH ORDINALITY AS tt(value, ord)
		LOOP
			INSERT INTO tasks (process_id, title, start_date, end_date, color, sort_order)
			VALUES (pid, tk.value->>'title', NEW.start_date, NEW.end_date, NULLIF(tk.value->>'color', ''), tk.ord)
			RETURNING id INTO tid;

			INSERT INTO assignments (task_id, resource_id, quantity)
			SELECT tid, (res.value->>'resource_id')::bigint, (res.value->>'quantity')::int
			FROM jsonb_array_elements(
				COALESCE(NULLIF(tk.value->'resources', 'null'::jsonb), '[]'::jsonb)
			) res
			WHERE (res.value->>'resource_id')::bigint IS NOT NULL;

			-- Operations → subtasks of the just-created task. Each inherits
			-- the project dates and the parent's process; status is the
			-- default 'not_started'; no color.
			FOR op IN
				SELECT value->>'title' AS title, ord
				FROM jsonb_array_elements(
					COALESCE(NULLIF(tk.value->'operations', 'null'::jsonb), '[]'::jsonb)
				) WITH ORDINALITY AS oo(value, ord)
			LOOP
				IF op.title IS NOT NULL AND op.title <> '' THEN
					INSERT INTO tasks (process_id, parent_id, title, start_date, end_date, color, status, sort_order)
					VALUES (pid, tid, op.title, NEW.start_date, NEW.end_date, NULL, 'not_started', op.ord);
				END IF;
			END LOOP;
		END LOOP;
	END LOOP;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_project_auto_create
AFTER INSERT ON projects
FOR EACH ROW
EXECUTE FUNCTION fn_project_auto_create();