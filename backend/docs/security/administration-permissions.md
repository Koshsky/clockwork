# Administrative capabilities

The permission matrix and `/permissions/me` describe actual API capabilities. Page visibility is an additional frontend check, never the security boundary.

| Capability | API permission | Boundaries |
| --- | --- | --- |
| View accounts | `user_admin.view` | `/user/accounts`, `/user/accounts/:id`; no password hashes for delegated users |
| Manage accounts | `user_admin.create/update/delete` | Profile writes, password resets and account deletion; role assignment retains its administrator-only invariant |
| Configure permissions | `rbac_config.update` | All `/rbac/*` operations and account profiles needed by the permission editor; no account mutations or template writes |
| New-project template | `auto_create.view/update` | Reads accept either action; writes require update. The UI groups both actions without rewriting partial legacy grants |
| Day-type dictionary | `state.view/create/update/delete` | Viewing and using labels is separate from editing the dictionary; employee calendar writes still require worker permissions |
| Company structure | `org_structure.view` | `/user/structure` returns only business identity, position, role and reporting links; no logins, hashes, employment dates or calendar entries |
| Activity log | `audit.view` | Read access only; the deployment may disable the audit service |
| Employee selection | `user_catalog.view` | Picker candidates, independent of accounts, employee calendars and the company chart |

A permission administrator can change their own rights. Delegate this capability only to trusted operators. Denying one alternative of an `any_capability` check does not deny another independently granted alternative. Such checks accept only ownerless capabilities; they cannot bypass ownership checks on projects, tasks, resources or employees.

## Upgrade from V13

V14 snapshots and translates custom preset rules and per-user grants/revokes:

- Old `rbac_config.view` becomes `rbac_config.update`: the old view already authorized all RBAC mutations.
- Old `rbac_config.update` becomes `auto_create.update`; it never becomes a new permission-administration grant.
- Old `rbac_config.view` also becomes `auto_create.view`. A legacy template reader stays read-only.
- Old `state_admin.view` folds into `state.view` only when that same dictionary rule is absent. Existing dictionary grants or explicit denials retain precedence.
- Inoperative page/action flags are removed. Deployment-specific resources, unrelated grants and custom route definitions remain untouched. Standard route checks are updated and the new account/structure checks are added.

Built-in role defaults are unchanged. Reset publishes the new route defaults and catalog; it does not reintroduce obsolete flags. Only V14 is new: V1–V13 remain byte-for-byte unchanged, preserving the documented Flyway adoption path.

The frontend shows partial saved actions as mixed. Choosing a common value explicitly replaces just that setting's actions. Cancellation and failed saves preserve the relevant draft; unrelated rights are not bundled into administrative access.

## Validation

- `go test ./...` for engine, services and handlers.
- `MIGRATION_TEST_DATABASE_URL=... go test ./internal/migration -parallel=1 -run 'TestAdministrationUpgrade|TestBuiltInRolesUpgrade'` against a disposable local `erp_migrator_*` database. Preinstall `btree_gist` to avoid concurrent extension creation on a fresh database.
- Frontend: `npm run check`, `npm run lint`, `npm run test:stories -- --project unit`, and the `UserPermissionsEditor` browser stories.
- `RBAC_TEST_ADMIN_PASSWORD=... npm run test:rbac:admin` uses temporary local accounts/roles to exercise real HTTP, persistence, page controls, live revocation and failed-save handling. It accepts loopback targets only.
