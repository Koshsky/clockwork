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

## Local acceptance follow-up (2026-11-11)

A local topic branch fixes the four acceptance findings: delayed unauthorized
responses no longer rotate an already restored token, manual Push renews an
offline session before sending mutations, the offline regression respects durable
temporary-ID mappings, and desktop packaging compares payload files while ignoring
only `.gitkeep` placeholders. Browser-owned refresh locks are authoritative when
Web Locks is available; the storage lease remains the fallback when it is absent.
This prevents a closed document's lease from blocking a new Electron process.

Validation uses a disposable PostgreSQL 16 database, synthetic credentials and
independent browser/Electron profiles. The frontend has 702 passing unit tests
and 20 passing CSP, static-server and payload-verification checks. The official
Linux portable packaging script completes successfully. Three independent macOS
Electron profiles preserve the session, cached task and mutation queue across a
full offline process restart, then deliver the task exactly once with one manual
Push and automatic synchronization disabled. Resource-header/recalculation browser
stories pass in days and weeks.

The browser acceptance also passes 27 navigation transitions, 141 backend-driven
RBAC checks (three consecutive runs), ten multi-tab scenarios, seven offline P0
cases in each environment, resource ownership/filtering, 40 PDF checks and native
CSP enforcement. Direct HTTP session-lock tests pass all five checks. RBAC menu
tests wait for catalogue loading and use real pointer input before asserting
permissions; no authorization assertions were removed.

The macOS runs use the real main/preload and freshly built web payload, with
`app.isPackaged=false`; they do not stand in for Windows/Linux GUI execution or a
signed macOS installer. At acceptance time, no GitHub push, image publication or
server deployment was performed. Published versions and migration SQL are unchanged.
