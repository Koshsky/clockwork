# Shared task and process scope checks

Run against the local dev API on port 8080:

```sh
node tests/shared-groups.mjs
node tests/resource-ui.mjs
npx vitest run --project unit
```

The API script reads local administrator credentials from `../local/dev.env` without printing them. It creates temporary users and projects and removes them in `finally`. Auto-created process templates are removed only from those temporary projects, so environment templates cannot change the expected task set. Run live API/browser suites sequentially to avoid shared rate-limit interference.

| Requirement | Coverage |
| --- | --- |
| Process `sib`: all processes in a project containing an employee-owned process | API process list and direct GET, creation, deletion; frontend action gates |
| Process ownership or an owned task alone cannot qualify the wrong shared group | API negative fixtures and frontend action gates |
| Task `sib`: all tasks and subtasks in a process containing an employee-owned task | Exact paginated list/count, diagram, direct GET/PUT/DELETE, frontend gates |
| Task `sib` ignores task parent boundaries but cannot cross process boundaries | Owned subtask under one parent, foreign subtask under another, foreign process in the same project |
| Task `sib_project`: all tasks across processes in a project containing an employee-owned task | Same checks plus cross-process creation; other projects remain denied |
| Parent process/project ownership alone does not qualify shared task scopes | Owned-process-only and owned-project-only negative fixtures |
| Creation cannot bootstrap access with a proposed owner | Denied task/process creation in an unqualified group |
| Subtasks can be created under a visible foreign-owned parent | API creation with separate parent and process checks |
| Dynamic access follows the last qualifying task | Revoke/restore ownership, delete the last owned task, repeat collections and direct operations |
| Forbidden writes preserve rows | Compare administrator reads before and after denied updates/deletes and process reparenting |
| Task project scope is a separate, task-only condition | Go parser/applicability/flag tests; frontend parser/probe tests; independent UI toggles |
| User permission rules persist the new expression | Create a user with the expression, log in and exercise all four actions |
| Probe failures cannot grant access | Go error/nil probe tests; frontend missing-evidence tests |
| Labels, descriptions and help switch languages | Browser preset editor and help checks; bilingual label unit tests |

Task `sib` now means shared process, including different task parents. Existing expressions keep their stored token but use this explicitly requested broader process boundary. The new `sib_project` option is not enabled by default. Neither change needs a schema migration; the core Flyway/golang-migrate migration files remain unchanged.
