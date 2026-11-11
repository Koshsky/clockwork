# Resource and parent-ownership RBAC acceptance coverage

Process permissions follow project ownership and task permissions follow process ownership for every action. Process/task row owners no longer grant access by themselves. V12 migrates existing self/own preset and user rules to up1; resources, projects, milestones and assignment rules retain their agreed semantics.

Local commands (frontend and backend must already be running):

```sh
node tests/resource-rbac.mjs
node tests/ownership-mutations.mjs
node tests/ownership-create.mjs
node tests/project-subtree.mjs
node tests/resource-ui.mjs
node tests/admin-resource-header.mjs
node tests/preset-denial.mjs
npm run check
npm run lint
npx vitest run --project unit
```

Backend and migration checks:

```sh
cd ../erp-backend
go test ./...
scripts/test-migration-upgrade.sh
```

The API integration test uses the real backend on loopback port 8080 and creates disposable users, resources, projects and a preset. The UI test uses a separate Chrome context, controlled Pinia permissions and mocked subject-preview reads. Both read the local administrator password from `../local/dev.env` without printing it. The migration script uses disposable Docker databases, not the working database.

| Requirement | Automated assertion |
| --- | --- |
| Project subtree includes owned processes OR owned tasks | `project-subtree.mjs` checks an owned empty process, an owned process containing only foreign tasks, an owned task in a foreign process, an owned subtask only, and both process/task ownership without duplicate projects. Foreign-only and empty projects remain hidden, including an owned empty project when only down is granted. |
| Project subtree is consistent in lists, diagrams and direct mutations | The same fixtures exercise paginated lists with exact totals, project and process diagrams, and direct GET/PUT/DELETE. Multiple owned processes/tasks do not duplicate a project. Allowed deletes remove child processes/tasks; denied writes leave the entire project unchanged. Losing the sole owned process or task revokes list/diagram/GET/PUT/DELETE access immediately; restoring its owner restores access. |
| Resource navigation appears when any action is granted | `resource-ui.mjs`: view-only, create-only, update-only and delete-only iterations; `resourceAccess.test.ts` tests each independent action. |
| Navigation disappears when all actions are denied | `resource-ui.mjs`: empty permission list; `resourceAccess.test.ts`: all four denied. |
| Create button appears exactly when create is granted | `resource-ui.mjs`: button count for each of the four independent grants and no grants. |
| Context menu requires edit or delete on that row | `resource-ui.mjs`: view-only, edit-only, delete-only and both actions; foreign row with own edit/delete has no menu. |
| List contains only visible resources | UI own/all/none rows; real API list and own/foreign id requests for self/all/none. |
| Own create defaults to caller and cannot target another owner | `resource-rbac.mjs`: omitted owner succeeds; foreign owner is forbidden. |
| Own read/update/delete work only on own records | `resource-rbac.mjs`: each action on an own and a foreign fixture, including direct id reads. |
| All create/read/update/delete work across owners | `resource-rbac.mjs`: all-scope fixture iteration. |
| No access denies all CRUD and listing/direct reads | `resource-rbac.mjs`: none-scope iteration. |
| Own update cannot transfer ownership to another user | `resource-rbac.mjs`: transfer rejected for own, allowed for all. |
| Preset View/Manage groups support explicit denial and empty selection | `resource-ui.mjs`: six blocks, two groups each, last grant removed without fallback; `preset-denial.mjs`: all 24 concrete rules removed, saved and reloaded, with real API denials. |
| New roles have four own actions on six resources | `resource-rbac.mjs`: exactly 24 server-created defaults; self for resources/projects, up1 for processes/tasks/milestones/assignments. Creation of all six entity types is exercised with the new role. |
| Own milestones belong to own processes | New-role milestone creation in an own process succeeds, creation in a foreign process is forbidden; up1 default assertion. |
| Own assignments require own resources and own tasks | Real API: own resource in own task succeeds; another owner's task in the same process fails. |
| Task viewing follows the process, including direct ids | `resource-rbac.mjs`: tasks in an own process return 200 regardless of task owner; an own task inside a foreign process returns 404 without entity data. All-scope controls return 200. The planning response applies the same boundary. |
| Project and process direct access follows the configured owner boundary | Own projects return 200 and foreign projects 404; processes in own projects return 200 regardless of process owner, while an own process in a foreign project returns 404. All-scope controls prove the fixtures exist. |
| Own milestone viewing follows the process owner | Direct GET returns a milestone in an own process (200), hides milestones in foreign processes (404 with empty data), including a foreign process inside an own project; all-scope reads succeed. |
| Own assignment viewing requires an own task and own resource | Direct GET returns the own assignment (200), hides an own-resource assignment to a foreign task in an own process and a foreign-resource assignment to an own task in a foreign process (404 with empty data); all-scope reads succeed. |
| Historical assignments cannot bypass own-resource checks | `TestAssignmentViewOwnRequiresTaskAndResource` covers own/foreign/missing resource owners independently of process ownership, foreign task owners, all scope and administrator access. Foreign-resource and missing-owner cases reproduced 200 responses before the fix and now return 404. |
| Own-scope direct PUT/DELETE cannot mutate foreign projects/processes/tasks/milestones/assignments | `ownership-mutations.mjs` checks all five entity types with view=all and update/delete=own: foreign objects are readable (200), own update/delete succeeds, foreign update/delete returns 403, and an administrator read proves the entire foreign record is unchanged after each rejection. A body that attempts ownership takeover or reparenting cannot bypass the source check. All-scope update/delete controls succeed. |
| An own-scope update cannot escape into foreign ownership | API regressions reject a project transfer to another owner, process moves to foreign projects, milestone moves to foreign processes, and assignment moves to foreign tasks/resources. With parent scopes, process/task owner changes inside an own parent are allowed and tested; all-scope controls allow valid moves. |
| Historical assignment mutations check both task and resource owners | `TestAssignmentMutationsOwnRequireTaskAndResource` runs update/delete checks for own tasks/resources, foreign tasks, historical foreign resources, missing resource owners and the administrator bypass (10 cases). |
| Creation enforces the configured ownership boundary | `ownership-create.mjs` tests omitted/null owner defaults, explicit owners, forbidden foreign project owners, invalid negative/string/boolean/fraction/zero ids and parent-id forgery. A project's zero owner is normalized to the caller; process/task zero ids are rejected. Accepted owners are checked again with an administrator GET. |
| Process/task creation requires an owned parent | The real API rejects both visible and invisible foreign parents even with view=all; a forged owner_id cannot override the project/process owner. Within an own parent, omitted/null owner defaults to the caller and explicit foreign owners are allowed. Each denied POST leaves the entity total unchanged. |
| Subtasks cannot use an inaccessible parent or substitute the process | `ownership-create.mjs` reproduces both forbidden-parent creation and process-id smuggling, checks own-parent success, and rejects process mismatch even for all scope/admin. `TestTaskCreateParentAccess` covers 8 middleware cases; `TestApplyParentRejectsProcessSubstitution` covers 2 service cases and date/owner preservation. |
| Milestone and assignment creation cannot spoof ownership through extra fields | The API ignores the nonexistent owner_id on own milestone/assignment payloads, denies milestones in foreign processes, foreign tasks/resources in assignments, and inaccessible tasks. All-scope controls succeed while all/admin process/resource owner mismatches remain forbidden. |
| All assignments allow resources only in accessible tasks | Real API: all-scope user with task.view=all can assign in a foreign user's process when owners match; assignment.create=all with task.view=self cannot assign in a foreign task. |
| Process and resource owners always match for assignments | Real API mismatch rejected for own, all and admin; assignment reassignment rejected. SQL integration also attempts direct insertion and moving the task across process owners. |
| Resource owner change deletes that resource's assignments | Real API old assignment returns 404; SQL integration count becomes zero; Pinia regression removes only the selected resource's assignments. |
| Process owner change deletes assignments of its tasks | Real API old assignment returns 404; SQL integration count becomes zero; Pinia regression preserves another process's assignments. |
| Same owner, title-only edits, or rejected changes preserve assignments | SQL integration and `planningDates.test.ts` verify unchanged ownership and unrelated edits; rejected writes preserve the local resource lists. |
| Transaction rollback restores removed assignments | `TestAssignmentOwnerInvariant` changes an owner inside a transaction, rolls back, and verifies the assignment remains. |
| Complete resource header, independently of resource-table pagination | `useOwnedResources.test.ts` loads 501 owned resources across two API pages, excludes foreign rows, restores complete offline snapshots, and loads all owners without an owner filter in administrator system mode. |
| Offline resource CRUD and owner changes survive reload | `cacheApply.test.ts` checks create/delete/owner updates, cached task-assignment cleanup and current-account cache isolation; `outbox.test.ts` checks FIFO cache replay. |
| Non-admin resource header contains exactly owned resources | UI asserts the single owned code despite foreign cached rows and no assignments; pure helper verifies no ownerless/foreign rows. |
| Admin system view includes all resource owners | `resource-ui.mjs` checks own and foreign resource codes; `useOwnedResources.test.ts` covers unfiltered pagination, offline snapshots and scope changes. |
| Admin owner filter changes resource rows only | `admin-resource-header.mjs` checks both owners, hides users without resources, retains every project/process/task and editing handles, and makes no impersonation requests. |
| Subject preview cannot perform writes or be used by a non-admin | Auth middleware table tests; real API rejects a non-admin subject header and administrator POST with that header. |
| Preview cannot contaminate normal cache or fall back to whole-system data | Two dedicated `http.test.ts` regressions. |
| Preset hint is understandable and translated | UI opens the new Russian hint and switches to its English counterpart; both explain own/all, ownership and assignment cleanup. |
| Remove grant-count captions | UI asserts zero `.pm-block-summary` elements. |
| Existing Flyway installations can upgrade to V11 | Migration rehearsal runs both V1–V9 plus unknown plugins and already-applied V10; checks unchanged Flyway history and data, then native V12 and restart. `TestParentScopesUpgrade` verifies preset rules, individual overrides, compound scopes, unchanged resources/projects, preserved denials and repeated startup. |

V11 adds database enforcement for new or edited assignments and transactional cleanup on ownership changes. It does not silently rewrite historical assignments. The local audit after implementation found zero existing mismatches. Published V1–V10 files are unchanged.

## Frontend management controls

The preset editor groups create/update/delete into Manage only in the UI. Backend action names, storage and authorization remain separate. A mixed group displays the original scopes and is not changed until an administrator explicitly selects a common condition. Empty selection and No access are equivalent; defaults apply only when a role is created.

`preset-denial.mjs` uses a disposable role and user. It verifies the three concrete write actions, save/reload, list/direct-ID/CRUD denial for all six entity types, re-granting, failed saves, failed matrix refresh and partial management failures. Accepted writes are reconciled from the server; rejected or unconfirmed drafts stay pending. Cleanup removes only the disposable fixtures. Run live suites sequentially.
