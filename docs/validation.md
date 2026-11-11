# Initial migration validation

Source snapshots: frontend d9892d2; backend 039037b. The initial import preserved
application source, generated API implementation and embedded SQL. Integration
changes cover repository layout, development configuration, tooling and CI; the
subsequent focused backend lint cleanup is described below.

Verified locally:

- 684 frontend unit tests, type checking and ESLint.
- Production frontend build and 14 CSP/static-server checks.
- Backend go build, go vet and go test across all packages.
- Pinned OpenAPI Generator 7.24.0 produces the existing TypeScript contract.
- Docker Compose configuration and both linux/amd64 Docker builds.
- Isolated PostgreSQL/backend/frontend/Caddy stack: native migrations, HTTP health,
  login, refresh, RBAC and planning; frontend version 1.6.3 and SPA routes.
- Root ignore rules retain source/templates/icons and exclude local state.

The initial full backend lint found eight inherited issues: one gocognit, four
goimports, two golines and one unparam issue. With the user's approval, a focused
follow-up fixed field alignment, specialized the admin test helper and extracted
the task dependency-date guard without changing its behavior. Nine new task
update cases cover unchanged dates, individual/both date changes, an absent
checker and rejected writes. Full golangci-lint now reports zero issues, with no
rule suppressions or generated-file changes.

No desktop installer or cross-platform Electron UI test was run for this move.
The Electron source, appId, userData and relative frontend/desktop relationship
are unchanged. No server deployment or Docker Hub promotion was performed.

The first GitHub run also exposed a stale optional canvas dependency in the
inherited npm lockfile and a prebuilt linter/export-data mismatch. The lockfile
was regenerated with Node 22/npm and verified by a clean Linux install, typecheck,
lint and all 684 unit tests. CI builds golangci-lint v2.15.0 with the configured Go
toolchain. Version 2.13.2 could not read Go 1.27 export data even when rebuilt;
both the importer's dependencies and build toolchain must support this format.
These tooling fixes follow the initial snapshot in a short-lived branch; the
published initial commit is not rewritten.
