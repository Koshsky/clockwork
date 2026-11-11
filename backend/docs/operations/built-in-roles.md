# Predefined roles and inherited viewing

V13 updates existing `dp`, `rp`, `vp`, and `worker` preset tags. It does not recreate deleted tags, rename presets, modify custom presets, or replace personal overrides. Rules for the four existing predefined tags are replaced intentionally. Before upgrading, back up the database. Startup applies the new migration through the embedded golang-migrate runner; the documented explicit adoption of Flyway V1–V9 or V1–V10 and unknown plugins remains supported.

| Preset | Viewing | Management |
| --- | --- | --- |
| `admin` | Everything | Everything; assignment owner matching still applies |
| `dp` | All planning and read-only resource catalog | Project priorities only |
| `rp` | Owned projects and their full contents; own resources and resources of process owners in those projects | Owned projects and their full contents; no resource management |
| `vp` | Projects containing an owned process and all their contents; own resources | Owned processes and all their contents; own resources; existing subordinate timesheet rights |
| `worker` | No preset grants | No preset grants |

Personal overrides continue to apply, except that a descendant view denial never cancels an ancestor view grant. Viewing a project opens its processes, tasks, subtasks, milestones and assignments. Viewing a process opens its contents. Viewing a task opens its subtasks and assignments. Inheritance never grants creation, editing, deletion, priority changes, resource management, or access to an ancestor. Context rows attached to planning aggregates do not grant direct access to their parent objects.

Project priority is a separate `project/prioritize` capability. A priority-only project update requires this capability; metadata requires `project/update`; a mixed payload requires both. V13 copies legacy custom-preset project-update scopes and personal project-update grants/revokes to `prioritize`, preserving existing explicit custom permissions. New custom presets receive the extra own-project priority rule.

Exact ownership conditions are independent of legacy tree expressions: `project_owner` checks only the project owner; `process_owner` checks only the process owner; `process_projects` selects projects containing an owned process; `project_resources` reads resources of process owners in employee-owned projects. Creation and reparenting also validate the destination. Resource and process owners must match for assignment regardless of preset, and ownership changes remove assignments through V11.

The UI exposes compact owner conditions; existing peer/other complex expressions stay readable and retain their meaning until explicitly replaced. Parent-wide View grants disable ineffective descendant View controls. Scoped inherited access is labelled “Through parent only”, and management stays editable separately. Resource-header visibility remains restricted to the current user's own resources.

## Validation

- Go factory matrix tests cover every preset, resource, CRUD action and sampled ownership position, plus project priorities.
- Middleware tests reject case aliases that could hide owner/parent changes from authorization.
- V13 integration tests compare migrated defaults with Go defaults, preserve custom rules/overrides, and check deleted presets and repeated startup.
- `scripts/test-migration-upgrade.sh` rehearses real Flyway V1–V9 with unknown plugins and already-applied V10, preserving history and data.
- Frontend `tests/built-in-roles.mjs` exercises real API CRUD, scoped lists/counts, diagrams and direct access for every role.
- Frontend `tests/view-inheritance.mjs` checks parent grants against child denials, task ancestry, exact lists/counts/diagrams and independent mutations.
- Frontend `tests/built-in-roles-ui.mjs` checks both real editors, disabled ineffective denials, translated priority controls and compact choices.

These scripts use disposable fixtures against the local development backend. No production rollout is part of this change.
