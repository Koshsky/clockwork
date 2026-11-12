-- Revisions are aggregate snapshots, not wall-clock timestamps; tombstones prevent ABA after deletion.
CREATE TABLE operation_revisions (
    key TEXT PRIMARY KEY,
    revision UUID NOT NULL
);

CREATE FUNCTION bump_operation_revision(revision_key TEXT) RETURNS VOID LANGUAGE sql AS $$
    INSERT INTO operation_revisions (key, revision)
    VALUES (revision_key, gen_random_uuid())
    ON CONFLICT (key) DO UPDATE SET revision = EXCLUDED.revision;
$$;

-- Match the existing V11 writer-lock order before touching rows or their cascading children.
CREATE FUNCTION operation_revision_writer_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(718226341);
    RETURN NULL;
END;
$$;

CREATE FUNCTION bump_operation_process(process_key BIGINT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE project_key BIGINT;
BEGIN
    IF process_key IS NULL THEN RETURN; END IF;
    PERFORM bump_operation_revision('process:' || process_key);
    SELECT project_id INTO project_key FROM processes WHERE id = process_key;
    IF project_key IS NOT NULL THEN
        PERFORM bump_operation_revision('project:' || project_key);
    END IF;
END;
$$;

CREATE FUNCTION operation_revision_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous JSONB;
    current_row JSONB;
    record JSONB;
    identifier BIGINT;
    parent BIGINT;
BEGIN
    IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
    IF TG_OP <> 'DELETE' THEN current_row := to_jsonb(NEW); END IF;
    FOR record IN SELECT DISTINCT value FROM jsonb_array_elements(jsonb_build_array(previous, current_row))
                  WHERE value <> 'null'::jsonb LOOP
        identifier := (record->>'id')::BIGINT;
        CASE TG_TABLE_NAME
        WHEN 'projects' THEN
            PERFORM bump_operation_revision('project:' || identifier);
            FOR parent IN SELECT id FROM processes WHERE project_id = identifier LOOP
                PERFORM bump_operation_revision('process:' || parent);
            END LOOP;
        WHEN 'processes' THEN
            PERFORM bump_operation_revision('process:' || identifier);
            PERFORM bump_operation_revision('project:' || (record->>'project_id'));
        WHEN 'tasks', 'milestones' THEN
            PERFORM bump_operation_process((record->>'process_id')::BIGINT);
        WHEN 'assignments', 'task_dependencies' THEN
            SELECT process_id INTO parent FROM tasks WHERE id = (record->>'task_id')::BIGINT;
            PERFORM bump_operation_process(parent);
        WHEN 'resources' THEN
            PERFORM bump_operation_revision('resource:' || identifier);
        WHEN 'resource_members' THEN
            PERFORM bump_operation_revision('resource:' || (record->>'resource_id'));
        WHEN 'user_states' THEN
            PERFORM bump_operation_revision('user_days:' || (record->>'user_id'));
        WHEN 'states' THEN
            PERFORM bump_operation_revision('states');
        WHEN 'users' THEN
            PERFORM bump_operation_revision('user_days:' || identifier);
            FOR parent IN SELECT resource_id FROM resource_members WHERE user_id = identifier LOOP
                PERFORM bump_operation_revision('resource:' || parent);
            END LOOP;
        END CASE;
    END LOOP;
    RETURN NULL;
END;
$$;

DO $$
DECLARE table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['projects', 'processes', 'tasks', 'milestones',
        'assignments', 'task_dependencies', 'resources', 'resource_members', 'user_states', 'states', 'users'] LOOP
        EXECUTE format('CREATE TRIGGER operation_revision_lock BEFORE INSERT OR UPDATE OR DELETE ON %I '
            'FOR EACH STATEMENT EXECUTE FUNCTION operation_revision_writer_lock()', table_name);
        EXECUTE format('CREATE TRIGGER zz_operation_revision_changed AFTER INSERT OR UPDATE OR DELETE ON %I '
            'FOR EACH ROW EXECUTE FUNCTION operation_revision_changed()', table_name);
    END LOOP;
END;
$$;

SELECT bump_operation_revision('project:' || id) FROM projects;
SELECT bump_operation_revision('process:' || id) FROM processes;
SELECT bump_operation_revision('resource:' || id) FROM resources;
SELECT bump_operation_revision('user_days:' || id) FROM users;
SELECT bump_operation_revision('states');
