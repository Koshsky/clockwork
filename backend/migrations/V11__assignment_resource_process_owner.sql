-- Serialize ownership edits with assignment writes so concurrent changes cannot bypass validation.
CREATE FUNCTION assignment_owner_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(718226341);
  RETURN NULL;
END $$;

CREATE TRIGGER assignment_owner_lock BEFORE INSERT OR UPDATE ON assignments
FOR EACH STATEMENT EXECUTE FUNCTION assignment_owner_lock();
CREATE TRIGGER resource_owner_lock BEFORE UPDATE OF owner_id ON resources
FOR EACH STATEMENT EXECUTE FUNCTION assignment_owner_lock();
CREATE TRIGGER process_owner_lock BEFORE UPDATE OF owner_id ON processes
FOR EACH STATEMENT EXECUTE FUNCTION assignment_owner_lock();
CREATE TRIGGER task_process_owner_lock BEFORE UPDATE OF process_id ON tasks
FOR EACH STATEMENT EXECUTE FUNCTION assignment_owner_lock();

CREATE FUNCTION validate_assignment_process_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'assignments' THEN
    IF EXISTS (SELECT 1 FROM tasks t JOIN processes p ON p.id=t.process_id
               JOIN resources r ON r.id=NEW.resource_id
               WHERE t.id=NEW.task_id AND p.owner_id IS DISTINCT FROM r.owner_id) THEN
      RAISE EXCEPTION 'resource owner must match process owner' USING ERRCODE='23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'resources' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    DELETE FROM assignments WHERE resource_id=NEW.id;
  ELSIF TG_TABLE_NAME = 'processes' AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    DELETE FROM assignments a USING tasks t WHERE a.task_id=t.id AND t.process_id=NEW.id;
  ELSIF TG_TABLE_NAME = 'tasks' AND (to_jsonb(NEW)->>'process_id') IS DISTINCT FROM (to_jsonb(OLD)->>'process_id') THEN
    IF EXISTS (SELECT 1 FROM assignments a JOIN resources r ON r.id=a.resource_id
               JOIN processes p ON p.id=NEW.process_id WHERE a.task_id=NEW.id
               AND r.owner_id IS DISTINCT FROM p.owner_id) THEN
      RAISE EXCEPTION 'resource owner must match process owner' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER validate_assignment_process_owner BEFORE INSERT OR UPDATE ON assignments
FOR EACH ROW EXECUTE FUNCTION validate_assignment_process_owner();
CREATE TRIGGER validate_resource_process_owner BEFORE UPDATE OF owner_id ON resources
FOR EACH ROW EXECUTE FUNCTION validate_assignment_process_owner();
CREATE TRIGGER validate_process_resource_owner BEFORE UPDATE OF owner_id ON processes
FOR EACH ROW EXECUTE FUNCTION validate_assignment_process_owner();
CREATE TRIGGER validate_task_resource_owner BEFORE UPDATE OF process_id ON tasks
FOR EACH ROW EXECUTE FUNCTION validate_assignment_process_owner();
