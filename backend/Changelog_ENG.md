# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.3] - 2026-11-11

### Changed

- Administrative capabilities are isolated; migration preserves legacy grants and individual revokes.

## [1.4.2] - 2026-11-10

### Changed

- Viewing inherits from projects, processes and tasks despite child denials; management remains independent.
- V13 updates predefined roles and separates project priority changes while preserving custom roles and personal overrides.

- Tasks support shared-project access; shared-process access covers all tasks and subtasks, with consistent list, diagram and direct-ID scoping.

### Fixed

- Project subtree access includes owned processes and tasks; scoped project totals use the caller's user id.
- Process/task permissions use parent ownership for all actions; V12 migrates existing own-scope rules without changing denials.
- Resource ownership transfers are permission checked; administrator preview is read-only and assignments require matching process/resource owners.
- Own-scope assignment access checks the resource owner even for historical assignments.
- Updates validate resulting ownership to prevent own-scope transfers and assignment/milestone moves to foreign targets.
- Subtask creation checks parent-task access and rejects a process that differs from the parent's process.

## [1.4.1] - 2026-11-09

### Changed

- The backend embeds core SQL and uses golang-migrate with explicit Flyway adoption, preserving existing plugin history.

## [1.4.0] - 2026-11-06

### Added

- Projects, processes and tasks carry a `responsible_id` — the accountable person alongside the owner (existing task owners are backfilled into it).

## [1.3.1] - 2026-10-13

### Changed

- The administrator account is no longer seeded: it is created on the first launch with the password from `ADMIN_PASSWORD`.

### Fixed

- `GET /rbac/matrix` returns the full matrix for every preset (previously admin only), with `none` marking a missing right.

## [1.3.0] - 2026-10-07

### Added

- API error messages are localized by the `Accept-Language` header (Russian default, English available).

## [1.2.0] - 2026-10-06

### Changed

- Presets store three fields — tag (access code), name (display name) and description; built-in presets got Russian display names.

## [1.1.0] - 2026-10-01

### Changed

- No backend code changes; version aligned with the frontend v1.1.0 wave (MAJOR/MINOR sync rule).

## [1.0.2] - 2026-09-30

### Added

- Admin password reset now returns the generated password in the response (shown once).
- States support a custom color (`#RRGGBB`) on create/update.

### Fixed

- Seed migrations re-sync their serial sequences in place, so fresh databases never collide on default inserts.
- Preset names accept letters of any script (cyrillic included).

## [1.0.1] - 2026-09-30

### Fixed

- Seed migrations no longer desync serial sequences (`V1017__sync_sequences.sql` re-syncs them); creating users/resources no longer fails with a primary-key 409.
- User deletion no longer fails when a stored auto-create template has a malformed owner id.

### Changed

- Auto-generated usernames use the `surname.initials` format.
- User deletion returns a 409 conflict listing the referencing records.

## [1.0.0] - 2026-09-29

### Added

- Initial production release: layered Go/Gin service, Casbin RBAC/ABAC, JWT auth, planning/timesheet/project domains, archive-based soft delete, audit events to Loki, OpenTelemetry tracing.

### Changed

- Seed migrations moved to `migrations/seed/` (fixed explicit ids, idempotent).
