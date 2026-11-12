# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
The web app and the desktop wrapper are versioned together.

## [Unreleased]

### Fixed

- Session restoration avoids duplicate refreshes and restores authorization before manually sending offline changes.

## [1.6.3] - 2026-11-11

### Fixed

- The task diagram resource-owner filter now also filters resource badges on bars.

- Multiple tabs release idle storage connections, serialize queue delivery and safely coordinate session renewal without reverting tokens or losing pending references.

- Blocked local storage no longer leaves login pending indefinitely; timed-out writes are cancelled and connections can recover.

- Cached profiles no longer masquerade as logged-out sessions; 401 responses reach login without redirect loops and preserve queued work.

- Administrators see all resources; the owner filter affects resource-header rows and resource badges, and offers resource owners only.

## [1.6.2] - 2026-11-11

### Fixed

- Cached pages open during sibling session renewal, and pending edits no longer leave reloaded diagrams empty.

- Shared-tab session renewal and offline retries preserve queued changes through expiry, re-login and lost responses.

- Page navigation after session restoration no longer triggers redundant token refreshes.

### Changed

- Administration settings share one card; the day-type dictionary opens inside the timesheet.

## [1.6.1] - 2026-11-10

### Changed

- Web and desktop CSP restricts code execution while preserving PDF export, printing and offline synchronization.

- Task details, subtasks, dependencies, resources and discussion share a large card that preserves drafts between sections.

- PDF preserves diagram colors, badges, dates and zoom, printing complete selected items with repeated headers while retaining filters and Ctrl+S/Ctrl+P.

- Scope choices are simplified without peers, with explicit inherited viewing and separate priority controls.

- Preset Manage controls configure create, update and delete together while server permissions remain separate.
- Tasks support shared-project access; shared-process access covers all tasks and subtasks, with consistent list, diagram and direct-ID scoping.

### Fixed

- Fixed Markdown URL and SVG filter bypasses; stored XSS coverage includes user fields online, from offline cache and in PDF exports.

- Pages, context menus, editors and dragging check each action and object independently; revoked access closes the page.

- Individual permissions preserve separate action rules, support cancellation and reject stale responses after saving.

- Deselecting the last preset condition stages No access without automatically selecting a replacement.
- Process permissions follow the project owner and task permissions follow the process owner for all actions.
- Resource navigation and actions follow individual permissions; new roles start with own access, and task planning supports a read-only administrator subject view.
- Offline retries preserve the original idempotency key, FIFO order and exact temporary ID mappings across interruptions.
- Automatic synchronization flushes queued edits before refreshing the offline cache once a minute and preserves unconfirmed changes.
- Resource headers update optimistically for task dates, assignments and employee absences, with rollback on rejected changes.

## [1.6.0] - 2026-11-09

### Changed

- The read-only company chart groups employees inside manager cards, initially shows two manager levels and preserves the table view.

- The personal account groups user details, password security and application information into separate sections.

## [1.5.1] - 2026-11-07

### Fixed

- The project/process editor recalculates the displayed duration as the start/end dates change.

- Person badges recover automatically when the local user catalog is empty.

- Person badges consistently use surname and initials, omitting missing name parts without extra punctuation.

- Project and process owner/responsible badges now appear on Gantt bars and follow their display settings.

- The selected timeline unit, position and zoom are preserved when switching between projects, processes and tasks.

### Changed

- Project-code badges have independent settings for process and task bars.

- Weekly timelines use ISO 8601 week numbers and continuous Monday–Sunday weeks, with month boundaries positioned within weeks.

## [1.5.0] - 2026-11-07

### Added

- A Week timeline scale (week-of-month numbered in Roman numerals), with the today line placed precisely inside the current week and highlighting it.

### Changed

- The Decade scale is no longer offered in the scale menu or as the default unit (day/week only).

## [1.4.0] - 2026-11-06

### Added

- The project and process editors show the start/end dates with a computed duration.
- Projects, processes and tasks expose a responsible-person picker; owner and responsible badges are toggled per entity in Settings → Diagrams.

## [1.3.3] - 2026-10-20

### Fixed

- Dragging a project or process bar applies the new dates at once: the bar stays where it was dropped instead of jumping back to the old span until the change is saved.
- Renaming a project offline shows the new code immediately.

## [1.3.2] - 2026-10-13

### Fixed

- The permissions screen shows preset rights again: the full right set comes from the API, including sections that were hidden before.

## [1.3.1] - 2026-10-08

### Changed

- Diagrams: Projects, Processes and Tasks share one view position — the first visible date, the zoom and the cell width survive switching between the tabs.

### Fixed

- Badges on task bars are no longer dropped at fine zoom: the markers enabled in the settings always stay visible.
- The Resources page no longer paints "Loading…" over a filled table on a background refresh.
- Diagrams: the side column of names is an opaque band for the whole area height at any zoom — the content underneath no longer shows through.
- Diagrams: when zoomed, the "today" line and the grid lines no longer stop halfway down, and no empty scroll area is left below the last row.
- Diagrams: an object created from the context menu (project/process/task/milestone) starts exactly in the clicked cell, at any scroll offset and zoom; at the parent's edge its length is truncated instead of moving the start.

## [1.3.0] - 2026-10-07

### Added

- Multilingual UI: interface language (Russian/English/system) in Settings; the whole interface is translated (screens, planner, timesheet, PDF export, hint pages).
- The interface language also drives date and number formatting, the window title and the desktop shell dialogs.
- Hint pages ("?") are localized per interface language, with the Russian document as the fallback.
- API error messages follow the interface language (the client sends Accept-Language).

### Changed

- Task dependency links (fs/ss/ff/sf) in the planner are drawn as a line with a tick on the constrained date instead of arrowheads; the line shape (six variants) is chosen in the settings with a live preview.
- Diagram settings: badges and dependency lines are grouped into one "Diagram appearance" block, and badges got a preview.
- Diagram settings: the comments badge on a task bar can be switched off.
- The header language button is a toggle switch (only two languages are available) instead of a dropdown.
- The changelog dialog shows the changelog of the interface language (Changelog_ENG.md / Changelog_RU.md).
- The Settings sections "Sync" and "Connection" are merged into a single "Server" section.

## [1.2.1] - 2026-10-06

### Fixed

- Changelog dialog: doubled "v" in the current-version caption.

## [1.2.0] - 2026-10-06

### Changed

- Navigation of planner tables, the timesheet and DataTable tables now uses middle mouse button drag instead of the left one; the drag starts from any point of the table — bars, milestones and headers never block moving it.
- Tables with drag navigation keep the plain arrow cursor at rest (headers, rows, empty space); Gantt bars show a clickable pointer; while the middle button is held, the cursor globally turns into the grabbing fist.
- Weekday labels in the calendar header raised by a couple of pixels.
- Presets have three editable fields — name, tag (access code) and description — set on creation and changeable later; lists and selects show the preset name.
- The preset tooltip shows its description.
- Action notifications (saving, preset create/rename/delete, password change, sync) moved into the notification stack instead of colored text at the top of the page.
- Action button panels are aligned to the right edge so the notification stack cannot cover them.
- Diagram settings: default duration of a created project, in days.
- A changelog icon in the header opens the changelog (Changelog_RU.md) in a centered dialog.

## [1.1.0] - 2026-10-01

### Changed

- Tables (statuses, users, employees, resources, audit log, company structure) now use a shared table component: full-width card with an actions toolbar, sortable column headers, per-column filters sitting right under each header (underline style), expandable rows, horizontal scrolling for wide tables, and user-adjustable column widths (drag the header edge; widths are remembered per user; double-click resets a column to auto width).
- Interface settings on the Settings page: notification stack on/off and auto-hide time (3–10 s or never), light/dark/system theme, UI font size (small/default/large), and table page size (25/50/100); the employees roster gained separate "Position", "Resource" and "Resource owner" columns with their own filters.
- The Settings page is organized into switchable sections (Interface, Tables, Diagrams, Sync, Connection) with a segmented control; setting cards are width-capped.
- Settings: the "Clear local data" option removed.
- Hints are now Markdown files (`*.md` assets); the hint panel renders them through a dedicated safe Markdown view with a new `MarkdownView` component.

### Fixed

- Resources page: the list now refreshes from the network on page entry, so it no longer stays empty until a re-login when the cache is empty on a cold start (background sync disabled).
- Tasks page: the "Save to PDF" and help buttons are vertically centered in the toolbar with a small gap between them; the help button is now a rounded square.
- Mobile: the navigation drawer can now be closed again (scrim tap, menu item tap, browser back).

## [1.0.2] - 2026-09-30

### Added

- Sidebar icons are sourced from a bundled Lucide catalog (one glyph per section).
- Sidebar icons can be overridden at runtime by dropping custom SVG files into the mounted `assets/custom/icons` directory (no rebuild).
- States support a custom color: shown in the statuses list, the timesheet legend, the assignment panel and the day cells.
- User editor: resetting a password shows the newly generated password once.
- Audit page: when the backend journal is disabled, a help card explains how to enable it instead of a raw 404 error.
- Users page: sortable "Preset" column with Russian preset labels.
- Preset names accept letters of any script (cyrillic included); preset create/rename modals show local validation errors again.
- Profile page: connection status and app/version cards.

### Changed

- "Console" and "Status" tabs removed from the sidebar (the pages stay reachable by URL).
- Access editor highlights a row only while the frontend draft differs from the backend state.
- Settings page: per-domain warm-up toggles removed, tiles spaced tighter.
- User create/edit form: the cancel button is now "Back".
- Failed mutations are no longer rendered inline on pages — the toast stack is the single notification channel.

## [1.0.1] - 2026-09-30

### Changed

- Planning aggregates re-sync immediately after online mutations and on page entry; deleting a project instantly hides its processes and tasks everywhere, including the offline cache.
- User CRUD and hierarchy changes instantly refresh the roster, name catalogs and timesheet; "Employees"/"Timesheet" pages re-sync on entry.
- Default login preview in the "Create user" form uses the `surname.initials` format.
- Failed mutations surface through the bottom-left notification stack with a countdown timer.

### Fixed

- A broken custom hint no longer shadows the built-in hint with the same file name — the built-in page is kept.

## [1.0.0] - 2026-09-29

### Added

- Initial production release: planner Gantts, admin sections, offline-first data layer (IndexedDB cache, mutation outbox), themed UI, Electron desktop wrapper.

### Changed

- Users page: failed mutations show a visible error banner with the server message.
