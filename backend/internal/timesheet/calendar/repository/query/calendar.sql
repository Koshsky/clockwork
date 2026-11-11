-- name: ListResources :many
-- Scoped by the caller's resource view zone (calendar.view): a process owner
-- must not read capacity curves of resources outside its own scope. The route
-- policy already gates the endpoint on resource.view; a caller whose zone
-- resolves empty (no rule / none) gets every row — reference data must not be
-- dropped then.
SELECT id, title, code, owner_id
FROM resources
WHERE (
    @sc_all::boolean OR
    (@sc_project_resources::boolean AND EXISTS (
        SELECT 1 FROM processes rp JOIN projects rpr ON rpr.id = rp.project_id
        WHERE rp.owner_id = resources.owner_id AND rpr.owner_id = @user_id::bigint
    )) OR
    (@sc_self::boolean AND owner_id = @user_id::bigint) OR
    @sc_none::boolean
)
ORDER BY id ASC;

-- Members that could be active within the [start_date, end_date] window
-- (by hire_date/termination_date), without per-day expansion.
-- name: ListEmployeesForCalendar :many
SELECT u.id, rm.resource_id, u.hire_date, u.termination_date
FROM resource_members rm
JOIN users u ON u.id = rm.user_id
WHERE (u.hire_date IS NULL OR u.hire_date <= @end_date::date)
    AND (u.termination_date IS NULL OR u.termination_date >= @start_date::date)
ORDER BY rm.resource_id ASC, u.id ASC;

-- Absence intervals (is_available = false) overlapping the window, without expansion.
-- name: ListUnavailableRanges :many
SELECT rm.resource_id, es.start_date, es.end_date
FROM user_states es
JOIN resource_members rm ON rm.user_id = es.user_id
JOIN states s ON s.id = es.state_id
WHERE s.is_available = FALSE
    AND es.end_date >= @start_date::date
    AND es.start_date <= @end_date::date
ORDER BY rm.resource_id ASC, es.start_date ASC;