-- Normalization of user_states.
-- Merges adjacent and overlapping ranges of the same (worker, state)
-- into continuous ones: [1..9] + [10..20] of the same state -> [1..20].
-- Overlaps are already forbidden by the EXCLUDE constraint, so the key case
-- here is touching ranges (end_date + 1 >= next.start_date).
CREATE OR REPLACE FUNCTION fn_normalize_user_states() RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
    CREATE TEMP TABLE _norm_user_states ON COMMIT DROP AS
    WITH marked AS (
        SELECT id, user_id, state_id, start_date, end_date,
               LAG(end_date) OVER (
                   PARTITION BY user_id, state_id
                   ORDER BY start_date, end_date, id
               ) AS prev_end
        FROM user_states
    ),
    groups AS (
        SELECT id, user_id, state_id, start_date, end_date,
               SUM(CASE WHEN prev_end IS NULL OR start_date > prev_end + 1 THEN 1 ELSE 0 END)
                   OVER (
                       PARTITION BY user_id, state_id
                       ORDER BY start_date, end_date, id
                   ) AS grp
        FROM marked
    ),
    kept AS (
        SELECT id, user_id, state_id, grp,
               FIRST_VALUE(id) OVER (
                   PARTITION BY user_id, state_id, grp
                   ORDER BY start_date, end_date, id
               ) AS keep_id,
               MIN(start_date) OVER (PARTITION BY user_id, state_id, grp) AS min_start,
               MAX(end_date)   OVER (PARTITION BY user_id, state_id, grp) AS max_end
        FROM groups
    )
    SELECT DISTINCT id, keep_id, min_start, max_end FROM kept;

    DELETE FROM user_states es
    USING _norm_user_states n
    WHERE es.id = n.id AND n.id <> n.keep_id;

    UPDATE user_states es
    SET start_date = n.min_start,
        end_date = n.max_end,
        updated_at = NOW()
    FROM _norm_user_states n
    WHERE es.id = n.keep_id
      AND (es.start_date <> n.min_start OR es.end_date <> n.max_end);

    DROP TABLE _norm_user_states;
END;
$$;
