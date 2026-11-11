# Planner

The task diagram: rows are tasks and resources, columns are periods, cells are time spans.

- Tasks can be moved and stretched — changes are saved immediately.
- Dependencies (fs/ss/ff/sf): fs — the next one after the previous one finishes, ss — start together, ff — finish together, sf — the next one finishes the previous one.
- Links: the tick marks the date the link constrains (fs/ss — the successor's start, ff/sf — its finish); the line style is chosen in the settings.
- Dragging cannot create a cycle or place a task earlier than its predecessor.
- Changes are visible to others within the TTL (up to 30 seconds).
- Ctrl/Cmd+P — print the diagram to PDF.