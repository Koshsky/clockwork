# RBAC regression checks

Run against the local development backend and its disposable database. These suites create temporary users and planning objects and remove them afterwards. They do not change preset rules or real employee permissions. Both HTTP runners reject non-loopback URLs.

## Backend HTTP matrix

From `erp-backend`, with the local API already running:

```sh
set -a
source ../local/dev.env
set +a
export RBAC_TEST_API_URL=http://127.0.0.1:8080/api/v1
export RBAC_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD"
bash scripts/test-rbac.sh
```

`internal/authz/engine/http_integration_test.go` exercises the actual HTTP routes, database and permission engine, rather than mocking authorization. Without the two explicit environment variables the HTTP test is skipped by the ordinary Go suite.

| Objects | Actions | Grants |
| --- | --- | --- |
| Projects, processes, tasks, milestones, assignments, resources | View, create, update, delete | Denied, scoped, all |

The 72 matrix cases check allowed and foreign objects, direct IDs, filtered listings and counts, creation under foreign parents and forged owners. Additional checks cover unauthenticated requests, resource/process owner matching, and immediate grant/revocation with an existing access token. Both subjects keep the same `worker` preset; differences come from backend permission overrides.

Existing broader regression suites remain relevant: `tests/built-in-roles.mjs`, `tests/view-inheritance.mjs`, `tests/shared-groups.mjs`, `tests/resource-rbac.mjs` and `tests/preset-denial.mjs`. Run them sequentially to avoid the shared API rate limit.

## Frontend

```sh
npm run check
npm run lint
npm run test:stories -- --project unit
PLAYWRIGHT_CHANNEL=chrome npm run test:stories -- --project storybook src/components/planner/TaskPlanning/RbacActions.stories.ts
RBAC_TEST_API_URL=http://127.0.0.1:8080/api/v1 RBAC_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD" node tests/rbac-ui.mjs
npm run build
```

`RBAC_TEST_WEB_URL` defaults to `http://127.0.0.1:5173`; `PLAYWRIGHT_CHANNEL` defaults to `chrome`. The app must be served by Vite because the browser runner imports the running application's store to request a real permission refresh. It never injects a fabricated permission list or mocks `/permissions/me`.

| Layer | Checks |
| --- | --- |
| Route unit tests | All protected routes, exact action for user creation/editing, separate permission administration, resources with any permitted action |
| Capability unit tests | Parent and row ownership, legacy ancestor scopes, strict own-task assignment, unknown parents, deny/none |
| Component browser tests | Editable bars per object, separate milestone dates, per-group row reorder, subtask create/update/delete, assignment add/remove, revocation while open |
| Live application browser tests | Navigation and complete pages, direct URLs, inherited parent view, action-only grants, own/foreign menus and resize controls, read-only user catalog, live revocation and reload |

The page guard and the active-page watcher use the same permission map. Viewing a parent opens its descendants but never grants mutation rights. Resource assignment choices still require the same owner as the process, including for administrators. A UI gate is not an API security boundary; the backend HTTP matrix verifies enforcement independently.
