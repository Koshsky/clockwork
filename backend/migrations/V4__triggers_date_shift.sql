-- Shift child date ranges when parent boundaries move inward.
-- Preserve child duration when it can still fit inside parent bounds.
-- If child duration exceeds parent duration, child is set to parent bounds.

-- =============================================
-- Projects -> Processes
-- =============================================
CREATE OR REPLACE FUNCTION fn_projects_shift_process_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	shift_days INTEGER := 0;
	parent_len INTEGER;
BEGIN
	IF NEW.start_date > OLD.start_date THEN
		shift_days := shift_days + (NEW.start_date - OLD.start_date);
	END IF;

	IF NEW.end_date < OLD.end_date THEN
		shift_days := shift_days + (NEW.end_date - OLD.end_date);
	END IF;

	parent_len := NEW.end_date - NEW.start_date;

	IF shift_days <> 0 THEN
		UPDATE processes p
		SET
			start_date = CASE
				WHEN (p.end_date - p.start_date) > parent_len THEN NEW.start_date
				WHEN (p.start_date + shift_days) < NEW.start_date THEN NEW.start_date
				WHEN (p.end_date + shift_days) > NEW.end_date THEN NEW.end_date - (p.end_date - p.start_date)
				ELSE p.start_date + shift_days
			END,
			end_date = CASE
				WHEN (p.end_date - p.start_date) > parent_len THEN NEW.end_date
				WHEN (p.start_date + shift_days) < NEW.start_date THEN NEW.start_date + (p.end_date - p.start_date)
				WHEN (p.end_date + shift_days) > NEW.end_date THEN NEW.end_date
				ELSE p.end_date + shift_days
			END,
			updated_at = NOW()
		WHERE p.project_id = NEW.id;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_projects_shift_process_dates
AFTER UPDATE OF start_date, end_date ON projects
FOR EACH ROW
WHEN (NEW.start_date > OLD.start_date OR NEW.end_date < OLD.end_date)
EXECUTE FUNCTION fn_projects_shift_process_dates();

-- =============================================
-- Processes -> Tasks
-- =============================================
CREATE OR REPLACE FUNCTION fn_processes_shift_task_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	shift_days INTEGER := 0;
	parent_len INTEGER;
BEGIN
	IF NEW.start_date > OLD.start_date THEN
		shift_days := shift_days + (NEW.start_date - OLD.start_date);
	END IF;

	IF NEW.end_date < OLD.end_date THEN
		shift_days := shift_days + (NEW.end_date - OLD.end_date);
	END IF;

	parent_len := NEW.end_date - NEW.start_date;

	IF shift_days <> 0 THEN
		UPDATE tasks t
		SET
			start_date = CASE
				WHEN (t.end_date - t.start_date) > parent_len THEN NEW.start_date
				WHEN (t.start_date + shift_days) < NEW.start_date THEN NEW.start_date
				WHEN (t.end_date + shift_days) > NEW.end_date THEN NEW.end_date - (t.end_date - t.start_date)
				ELSE t.start_date + shift_days
			END,
			end_date = CASE
				WHEN (t.end_date - t.start_date) > parent_len THEN NEW.end_date
				WHEN (t.start_date + shift_days) < NEW.start_date THEN NEW.start_date + (t.end_date - t.start_date)
				WHEN (t.end_date + shift_days) > NEW.end_date THEN NEW.end_date
				ELSE t.end_date + shift_days
			END,
			updated_at = NOW()
		WHERE t.process_id = NEW.id;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_processes_shift_task_dates
AFTER UPDATE OF start_date, end_date ON processes
FOR EACH ROW
WHEN (NEW.start_date > OLD.start_date OR NEW.end_date < OLD.end_date)
EXECUTE FUNCTION fn_processes_shift_task_dates();

-- =============================================
-- Processes -> Milestones
-- =============================================
CREATE OR REPLACE FUNCTION fn_processes_shift_milestone_dates()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
	shift_days INTEGER := 0;
BEGIN
	IF NEW.start_date > OLD.start_date THEN
		shift_days := shift_days + (NEW.start_date - OLD.start_date);
	END IF;

	IF NEW.end_date < OLD.end_date THEN
		shift_days := shift_days + (NEW.end_date - OLD.end_date);
	END IF;

	IF shift_days <> 0 THEN
		UPDATE milestones m
		SET
			date = CASE
				WHEN (m.date + shift_days) < NEW.start_date THEN NEW.start_date
				WHEN (m.date + shift_days) > NEW.end_date THEN NEW.end_date
				ELSE m.date + shift_days
			END,
			updated_at = NOW()
		WHERE m.process_id = NEW.id;
	END IF;

	RETURN NEW;
END;
$$;

CREATE TRIGGER trg_processes_shift_milestone_dates
AFTER UPDATE OF start_date, end_date ON processes
FOR EACH ROW
WHEN (NEW.start_date > OLD.start_date OR NEW.end_date < OLD.end_date)
EXECUTE FUNCTION fn_processes_shift_milestone_dates();