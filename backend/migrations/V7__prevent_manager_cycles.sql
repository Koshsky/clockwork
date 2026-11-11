-- Bans circular dependencies in the manager hierarchy (users.manager_id).
-- The trigger walks the manager_id chain up from the new manager; if it
-- reaches the user themselves — circular dependency, error. Also forbids
-- direct self-management (manager_id = id). Fires on any write path
-- (API, SQL, migrations/seeds).
CREATE OR REPLACE FUNCTION prevent_manager_cycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    cur   BIGINT;
    depth INT := 0;
BEGIN
    IF NEW.manager_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.manager_id = NEW.id THEN
        RAISE EXCEPTION 'manager cannot be the user themself';
    END IF;

    -- Walk up the manager chain covering the whole live hierarchy
    -- (archived users are physically removed from this table).
    cur := NEW.manager_id;
    WHILE cur IS NOT NULL LOOP
        depth := depth + 1;
        IF depth > 1000 THEN
            RAISE EXCEPTION 'manager hierarchy is too deep';
        END IF;
        IF cur = NEW.id THEN
            RAISE EXCEPTION 'circular manager dependency is not allowed';
        END IF;
        SELECT manager_id INTO cur FROM users WHERE id = cur;
    END LOOP;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_users_prevent_manager_cycle
BEFORE INSERT OR UPDATE OF manager_id ON users
FOR EACH ROW
WHEN (NEW.manager_id IS NOT NULL)
EXECUTE FUNCTION prevent_manager_cycle();
