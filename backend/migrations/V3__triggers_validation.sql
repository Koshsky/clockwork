-- =============================================
-- VALIDATION BOUNDARIES: an explicit error instead of a silent soft-delete.
-- A process/task whose dates fall outside the parent's bounds is rejected with code 22023
-- (invalid_parameter_value); repositories turn it into 400.
-- Milestones outside the process bounds are clamped to the parent's bounds.
-- =============================================
CREATE OR REPLACE FUNCTION fn_processes_validate_within_project_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	parent_start DATE;
	parent_end DATE;
BEGIN
	SELECT p.start_date, p.end_date
	INTO parent_start, parent_end
	FROM projects p
	WHERE p.id = NEW.project_id;

	IF parent_start IS NULL OR parent_end IS NULL THEN
		RAISE EXCEPTION
			'Parent project % not found',
			NEW.project_id;
	END IF;

	IF NEW.end_date < parent_start OR NEW.start_date > parent_end THEN
		RAISE EXCEPTION 'Сроки процесса (% - %) выходят за границы проекта (% - %)',
			NEW.start_date, NEW.end_date, parent_start, parent_end
		USING ERRCODE = '22023';
	END IF;

	IF NEW.start_date < parent_start THEN
		NEW.start_date := parent_start;
	END IF;
	IF NEW.end_date > parent_end THEN
		NEW.end_date := parent_end;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_processes_validate_within_project_dates
BEFORE INSERT OR UPDATE OF start_date, end_date, project_id ON processes
FOR EACH ROW
EXECUTE FUNCTION fn_processes_validate_within_project_dates();

-- =============================================
-- Tasks: the same bounds, parent — process.
-- =============================================
CREATE OR REPLACE FUNCTION fn_tasks_validate_within_process_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	parent_start DATE;
	parent_end DATE;
BEGIN
	SELECT p.start_date, p.end_date
	INTO parent_start, parent_end
	FROM processes p
	WHERE p.id = NEW.process_id;

	IF parent_start IS NULL OR parent_end IS NULL THEN
		RAISE EXCEPTION
			'Parent process % not found',
			NEW.process_id;
	END IF;

	IF NEW.end_date < parent_start OR NEW.start_date > parent_end THEN
		RAISE EXCEPTION 'Сроки задачи (% - %) выходят за границы процесса (% - %)',
			NEW.start_date, NEW.end_date, parent_start, parent_end
		USING ERRCODE = '22023';
	END IF;

	IF NEW.start_date < parent_start THEN
		NEW.start_date := parent_start;
	END IF;
	IF NEW.end_date > parent_end THEN
		NEW.end_date := parent_end;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_tasks_validate_within_process_dates
BEFORE INSERT OR UPDATE OF start_date, end_date, process_id ON tasks
FOR EACH ROW
EXECUTE FUNCTION fn_tasks_validate_within_process_dates();

-- =============================================
-- Milestones: clamp the milestone date to the process bounds.
-- =============================================
CREATE OR REPLACE FUNCTION fn_milestones_validate_within_process_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	parent_start DATE;
	parent_end DATE;
BEGIN
	SELECT p.start_date, p.end_date
	INTO parent_start, parent_end
	FROM processes p
	WHERE p.id = NEW.process_id;

	IF parent_start IS NULL OR parent_end IS NULL THEN
		RAISE EXCEPTION
			'Parent process % not found',
			NEW.process_id;
	END IF;

	IF NEW.date < parent_start THEN
		NEW.date := parent_start;
	END IF;
	IF NEW.date > parent_end THEN
		NEW.date := parent_end;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_milestones_validate_within_process_dates
BEFORE INSERT OR UPDATE OF date, process_id ON milestones
FOR EACH ROW
EXECUTE FUNCTION fn_milestones_validate_within_process_dates();