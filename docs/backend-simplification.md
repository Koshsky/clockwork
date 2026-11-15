# Backend simplification: B01 baseline

Recorded on 2026-11-15 against `origin/main` at
`e46ea45af7c2465901ee4c22bd9d83d9cfe84908` (backend 1.5.0, frontend 2.1.0).
Tracker: [epic](http://localhost:3456/tasks/66),
[B01](http://localhost:3456/tasks/67).
The B01 sections below are an immutable architecture and compatibility snapshot;
the implementation ledger at the end records later steps. No application files,
SQL, generated code or versions move in B01 itself.

## What changed since the original plan

The original baseline was `4c3b9c5` on 2026-11-11. There are still 115 production
packages under `backend/internal`, but package count alone hides important
changes: 46 backend files changed, including the browser session transport,
durable operation receipts, revision guards, request-scoped transactions for
ordering, and V15. The plan's feature boundaries remain applicable; its
compatibility requirements must include these newer protocols.

Older task text also overstates the contributor rules: current backend guidance
describes the layered layout but does not explicitly require concrete repository
constructor parameters. Those concrete parameters are a code finding. Future
steps should update the layout/constructor guidance when changing that boundary,
not silently treat the planned layout as already implemented.

`internal/idempotency` is an intentional Gin adapter with transaction ownership,
not a new target for flattening. Its use of Gin is not an architecture violation.
The same distinction applies to `audit` middleware/client composition and
`server`: do not apply a blanket ban on HTTP imports to all of `internal`.

## Measured dependency graph

The machine-readable companion, [backend-baseline.json](backend-baseline.json),
contains every production package, direct internal imports, file/line counts,
contract fingerprints, OpenAPI operations and definition names. Counts use
`go list -json ./internal/...`, Go 1.27.2, darwin/arm64, normal build tags.
Lines include comments and blanks; test files are excluded. Generated sqlc
packages are counted separately, not treated as redundant hand-written layers.

| Area below `internal/` | Packages | Go files | Lines | sqlc packages |
| --- | ---: | ---: | ---: | ---: |
| audit | 3 | 11 | 1,422 | 0 |
| auth | 6 | 14 | 1,097 | 1 |
| authz | 8 | 26 | 6,005 | 1 |
| auto_create | 6 | 11 | 690 | 1 |
| idempotency | 3 | 14 | 1,951 | 1 |
| middleware | 5 | 11 | 1,047 | 0 |
| planning | 6 | 14 | 2,055 | 1 |
| project_mgmt | 39 | 98 | 8,392 | 7 |
| timesheet | 16 | 37 | 3,169 | 3 |
| user | 7 | 18 | 3,854 | 1 |
| Other infrastructure | 16 | 41 | 3,102 | 0 |
| **Total** | **115** | **295** | **32,784** | **16** |

There are 372 direct edges between internal production packages. The 16 sqlc
packages contain 50 files / 7,177 lines; the other 99 packages contain 245 files /
25,607 lines. No target package count is imposed.

### Confirmed dependencies to repair

| Current dependency | Evidence / consequence | Planned step |
| --- | --- | --- |
| Services and repositories → `middleware/rbac` | List scopes, resource kinds and owner chains are HTTP-owned types. Seen in user, planning, assignment, comment repository, milestone, process, project, task, calendar and resource. | B02 |
| `userctx` → Gin | Moving only `rbac.Resource` would leave the authenticated principal coupled to HTTP. `UserContext` and `PermissionRule` need neutral ownership too. | B02 |
| `tracing` → Gin | `tracer.go` mixes tracing primitives with HTTP span accessors. | B03 |
| `authz/engine` → `middleware/rbac` and `userctx` | `CheckCtx` carries HTTP path/query/body parsing into the decision engine. Gin is a transitive dependency even though engine does not import it directly. | B04 |
| `authz/service.PolicyStore` → `*rbac.Middleware` | Publishing policies requires the concrete HTTP adapter. | B05 |
| 15 service packages → concrete repository packages | Fields already use consumer interfaces; constructors still require concrete implementations. Auth also requires `*user/service.UserService`. | B06 |
| `auth/service.UserService`, `audit.UserLookup` → `user/dto.UserResponse` | Internal authentication and audit contracts depend on the API response model. | B07 |
| `auto_create/repository` → `auto_create/dto` | SQL access performs HTTP configuration mapping. | B18 |

Examples are dependency findings, not claims that these paths currently violate
access control. B01 changes no authorization decisions.

## Target boundaries and permitted dependencies

```text
server / module.go (composition)
  -> HTTP delivery + concrete repositories + business services
HTTP delivery / middleware
  -> business services + neutral authorization contracts + HTTP DTOs
business services
  -> consumer-owned interfaces + neutral types + own sqlc projections
concrete repositories
  -> database transaction context + own queries/sqlc + neutral scope types
```

- Business/core must not depend on Gin, HTTP middleware/delivery or concrete
  repositories. A consumer-owned interface does not hide a Gin request object.
- `authz/domain` is the existing home for shared authorization facts and
  principal types. Keep it independent of Gin and authorization evaluation.
  Gin context accessors stay in the HTTP adapter; preserve context-key identity
  while changing the type owner.
- Pure authorization decisions and SQL scope compilation stay in
  `authz/engine`. HTTP decoding and route-check closures move to
  `middleware/rbac`; avoid duplicating the decision logic there.
- Constructors accept the existing consumer interfaces and return concrete
  structs. Wire bindings and concrete assembly stay in module/server composition.
  Regenerate Wire; do not edit generated Go.
- Retain existing service ↔ HTTP DTO mapping for the small feature moves.
  Removing all DTO use from services is not part of this plan. Preserve public
  DTO package identities because they participate in Swagger definition names.
- Keep sqlc rows/projections as internal data. Do not mirror complete tables
  into hand-written domain models or introduce a generic repository/event bus.

### Where flattening is safe

Move business implementation, validation, mapping and repository interfaces from
`service/` into the feature root for
`project_mgmt/{milestone,comment,assignment,project,process,task_dependency,task}`
and `timesheet/{state,resource,calendar}`. Keep `delivery/`, `dto/` and the SQL
adapter/query/sqlc boundary. Start with milestone. Fold the small task status and
dependency-type catalogs into their corresponding feature roots.

The composition modules are `project_mgmt/module.go` and `timesheet/module.go`,
above these feature roots. In contrast, `auth`, `authz`, `user`, `planning` and
`auto_create` have their own `module.go` importing delivery. Moving their service
into that same root would create root → delivery → root cycles; retain the
service boundary. Keep audit's existing client/middleware composition explicit.

## Compatibility contract

| Surface | Required invariant and source of truth |
| --- | --- |
| HTTP routing | `/api/v1`; methods, singular/plural paths, parameters, route-policy names and public/protected placement. Review `server/routes.go`, module files, delivery route files and `idempotency/receipts.go`; schema alone is not a runtime route dump. |
| OpenAPI / frontend SDK | 57 documented paths, 93 operations, 92 definitions. Preserve schemas, required/nullable properties, JSON names, enums, security annotations and generated TypeScript. These counts cover documented endpoints only. |
| Responses / errors | Success `{data: payload, error: {}}`; failures `{data: {}, error: {code, message, timestamp}}`; 204 has no body. Pagination is `items,total,limit,offset` with default limit 50 and maximum 500. Preserve HTTP status/domain error classification, RU/EN locale behavior and private-error redaction in `internal/response`, `pkg/errors`, `pkg/messages`. |
| Dates and updates | Calendar strings use `pkg/date.Date` (`YYYY-MM-DD`), not the stale `internal/common/date` path in older guidance. Preserve absent/null/zero/empty distinctions, parent/owner checks, ordering, status/dependency codes and constraint behavior. |
| Authentication | `auth` uses the user service, not direct users-table access. Preserve cookie transport selected by `X-Erp-Session: cookie`, browser-origin checks, legacy desktop body credentials, refresh rotation/reuse handling, revocation and multi-tab behavior. Cookie and body modes must not accidentally merge. |
| RBAC | Preserve preset codes, per-user rules, route kinds/params, list scopes and inherited view. Compare list, planning and direct ID decisions separately from create/update/delete. Preserve parent-view inheritance without granting mutation rights, director priority-only writes, principal refresh and default-deny behavior. |
| Assignments | `process.owner_id = resource.owner_id` for every actor, including admin. Preserve task visibility checks and assignment cleanup when process/resource ownership changes. |
| Transactions / legacy replay | Every request-scoped write uses `q(ctx)` or `BeginOrJoin`; joined callers do not commit the owner's transaction. Preserve legacy `Idempotency-Key` scope, TTL and reply behavior. |
| Durable operations | Preserve capability handshake and supported route list; actor-scoped `Operation-Id`, exact method/URI/body/content-type fingerprint, matching optional legacy key, no receipt TTL, receipt lookup isolation, confirmed/in-progress/mismatch/unknown/unrecorded outcomes and atomic mutation + receipt commit. Never silently downgrade to legacy delivery. |
| Revision protocol | Preserve opt-in `Revision-Protocol: 1`, immutable `_preconditions`, `data.snapshot` + `data._revisions`, guarded 204 → 200, legacy unwrapped replies, strict aggregate invalidation, conflict rollback and authorization before exposing revision outcomes. Durable replay runs before revision checking. |
| Database / migration | Preserve all 15 tracked core SQL migrations V1–V15, queries, triggers, archives and sqlc configuration. V15 adds durable receipts/revisions. Unknown Flyway plugin history survives explicit adoption. No seed/plugin files or live data belong in the baseline. |
| UI integration | Preserve planning payloads/resource ownership, calendars/absences, comments, administration, two-tab sessions and Electron replay. ISO-week peak demand/minimum availability remains a frontend calculation. |

Fingerprints in `backend-baseline.json` are review evidence, not a new CI gate.
OpenAPI/SDK/DTO/SQL/migration drift is outside this structural refactoring's
scope. Route/composition and protocol-source fingerprints are reference-only:
implementation identifiers/imports can change, but their behavior must not.
Recheck protocol consumers and response/error semantics rather than requiring
byte-identical implementation source.

## Work sequence and test ownership

Each row is a reviewable topic branch/PR after its prerequisites. Finish and push
one independent change before starting the next branch. Owner approval is still
required before merging; B01 does not authorize executing the remaining steps.

| Step | Prerequisites | Change boundary | Existing regression ownership / required additions |
| --- | --- | --- | --- |
| B02 | B01 | `middleware/rbac`, `userctx`, `authz/domain`, scope consumers | `authz/engine/*_test.go`, middleware auth/RBAC, planning/calendar service tests; preserve all allow/deny combinations and context identity. |
| B03 | B01 | tracing + HTTP span adapter + server wiring | tracing tests, logger correlation, server middleware tests; verify success/error/cancel/shutdown. |
| B04 | B02 | engine HTTP builders → RBAC middleware | Keep pure engine tests with engine; move HTTP tests with the adapter. Exercise body aliases, owner/parent substitution, list/ID/mutations and inherited view. |
| B05 | B04, B06 | PolicyStore publication interface | Existing authz service/engine tests; add publication failure, last-good snapshot, TTL/reload and concurrent readers where coverage is missing. |
| B06 | B01 | existing constructor interfaces + Wire bindings | Per-module service stubs and normal application build; regenerate Wire once per coherent module change. |
| B07 | B06 | neutral user lookup contracts + auth/audit adapters | `auth/service/service_test.go`, browser-session, auth middleware, audit user/masking tests; preserve credential-field handling. |
| B08 | B02, B06 | milestone pilot | Engine milestone/parent-scope tests and HTTP RBAC suite; add focused service/validator/mapper tests before moving uncovered logic. |
| B09 | B08 | timesheet state | Administration/role engine tests, migration administration tests and UI day-type permissions. |
| B10 | B08 | comment | Comment validator and engine comment tests; HTTP task-discussion and XSS regression. |
| B11 | B08 | assignment | Engine assignment/create/update tests, migration owner-invariant integration, HTTP resource-RBAC tests; cleanup/transaction behavior must stay covered. |
| B12 | B08 | project | Engine related visibility, inherited view and priority tests; HTTP project-subtree and ownership mutation/create suites. |
| B13 | B08 | process | Engine parent/update tests, owner-cleanup integration, HTTP ownership and planning tests. |
| B14 | B08 | task_dependency service + tiny domain | Existing dependency validator/constraint and engine policy tests; preserve `task.ConstraintSource` consumer interface. |
| B15 | B14 | task service + tiny status domain | Existing parent/date-update tests, engine CRUD scopes and durable/revision HTTP tests. |
| B16 | B08 | resource | Engine resource scopes, owner-invariant integration and HTTP resource-RBAC/UI tests. |
| B17 | B16 | calendar | Nine existing calendar service tests, owner scopes, periods and frontend day/week resource scenarios. |
| B18 | B06 | auto_create repository DTO boundary | Auto-create mapping/default/empty/round-trip and atomic template creation; add missing focused checks before the move. |
| B19 | B02–B18 | final dependency guards + regression | `go list`/AST boundary rules with negative fixtures, full Go checks/race, API generation and local web/Electron acceptance. |

This ownership table identifies required validation, not an assertion that every
named behavior already has an executed integration test. In particular, several
small feature services have no dedicated tests today; the pilot and each later
move must close relevant gaps before changing behavior-bearing code. Do not
delete tests or substitute source-text assertions for behavioral coverage.

## Reproduce the baseline

Use a separate temporary checkout of the immutable source, without `.env`,
personal seed SQL, plugins, node_modules or any running-service credentials:

```sh
baseline=e46ea45af7c2465901ee4c22bd9d83d9cfe84908
snapshot=$(mktemp -d)
git archive "$baseline" | tar -x -C "$snapshot"
cd "$snapshot/backend"
go list -json ./internal/... > "$snapshot/packages.json"
go list -f '{{.ImportPath}}{{range .Imports}}{{printf "\n  -> %s" .}}{{end}}' ./internal/...
go list -f '{{.ImportPath}} {{len .GoFiles}} {{len .TestGoFiles}} {{len .XTestGoFiles}}' ./internal/...
```

Count only production `GoFiles`, not `TestGoFiles`, `XTestGoFiles` or test-package
variants. For each package retain only imports prefixed with
`github.com/Koshsky/erp-backend/internal/`; keep `repository/sqlc` nodes flagged
separately. Reject `Error`, `Incomplete` or `DepsErrors` instead of accepting an
incomplete graph. The snapshot is host-specific; use darwin/arm64 for exact graph
comparison, and also check Linux when implementing platform-sensitive changes.

The companion fingerprints cover tracked paths only. Each group is SHA-256 of
sorted lines `path + NUL + sha256(file bytes) + LF`, encoded as UTF-8. Selection
uses Python `fnmatch.fnmatchcase` against repository-relative tracked paths and
the pattern list stored with each group. This command checks current bytes and
path additions/deletions against the recorded group digests, from the repo root:

```sh
python3 - <<'PY'
import fnmatch, hashlib, json, subprocess
from pathlib import Path

baseline = json.loads(Path('docs/backend-baseline.json').read_text())
tracked = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
for name, group in baseline['contracts'].items():
    paths = sorted(p for p in tracked if p and any(
        fnmatch.fnmatchcase(p, pattern) for pattern in group['patterns']))
    records = ''.join(p + '\0' + hashlib.sha256(Path(p).read_bytes()).hexdigest()
                      + '\n' for p in paths)
    digest = hashlib.sha256(records.encode()).hexdigest()
    assert len(paths) == group['files'] and digest == group['sha256'], name
    print(name, len(paths), 'unchanged')
PY
```

This detects drift; it does not prove behavioral equivalence. After a structural
move, inspect reference-only groups and compare actual runtime routes/policies
and protocol behavior. Do not simply refresh fingerprints to hide a change.

## Validation and limits

| B01 check | Observed result |
| --- | --- |
| `go list -p=1 -json ./internal/...` | 115 packages, no package/dependency errors; complete internal graph recorded. |
| `go build -p=2 ./...` / `go vet -p=2 ./...` | Passed. |
| `go test -p=2 -json ./...` | 258 top-level tests passed, 16 top-level tests skipped; including subtests, 2,385 pass events and 20 skip events. 30 packages passed; 94 packages have no normal-tag tests. Test event window was 16.8 seconds, not a cold-build benchmark. |
| `go test -p=2 -tags=integration -list '^Test' ./...` | All 338 declared test functions compiled/listed, including 64 functions in seven integration-tagged files. Listing does not execute their assertions. |
| `go test -p=2 -race` for auth service, authz engine/service, idempotency and auth middleware | All five selected packages passed; environment-dependent tests still skipped. |
| golangci-lint 2.15.0, concurrency 2 | Passed, 0 issues. |
| Frontend unit resource scenarios + web reads | 75 tests in two files passed; Vitest duration 611 ms. This is not browser or Electron acceptance. |
| Contract fingerprints / repository policy / whitespace | All 12 groups unchanged; repository policy and `git diff --check` passed. |
| `scripts/generate-api.sh --check` | Not run: the configured local Docker endpoint has no running daemon. Existing schema/SDK bytes were fingerprinted; fresh generation parity is not claimed. |
| PostgreSQL / HTTP / Electron acceptance | Not run: no disposable DB/API/profile was started for this documentation-only step. |

The ordinary run used no DATABASE_URL, MIGRATION_TEST_DATABASE_URL,
OPERATION_TEST_DATABASE_URL, OPERATION_TEST_API_URL or RBAC_TEST_API_URL. Migration
tests and the RBAC HTTP suite accounted for the reported skips. Tests with the
integration build tag were separately compiled/listed, not counted as executed.

The default Go cache initially reproduced a stale standard-library read error
(`too many open files in system`), while system file counts were well below the
limit. An independent temporary GOCACHE produced a clean graph, build, vet,
tests, race and lint run with GOMAXPROCS=2. No global cache was cleared and no
system limit was changed. Raw graph and validation logs are retained locally
outside Git in `../local/backend-b01-20261115/` relative to the repository root.

Future implementation uses `go build ./...`, `go vet ./...`, `go test ./...`,
pinned golangci-lint 2.15.0, and targeted `go test -race` for
publication/session/replay paths. Wire changes require normal regeneration;
API changes require
`scripts/generate-api.sh --check`, never manual generated-code edits.

DB/HTTP suites need explicitly isolated local fixtures. Build-tagged tests under
auth repository and idempotency do not run in ordinary `go test ./...`; migration
and RBAC HTTP tests also skip without their test environment variables. Preserve
these distinctions in reports. Neither skipped tests nor successful compilation
prove PostgreSQL atomicity or browser/Electron compatibility.

B01 does not start databases, Docker services, Electron, CI, image builds,
releases or deployments. Local compilation/testing does not publish an artifact.

## B02/B03 implementation ledger — 2026-11-15

Implemented together on `refactor/backend-access-tracing`, based on B01 commit
`36c4dcf`, with two agents owning disjoint files and a coordinating integration.
The original `backend-baseline.json` remains unchanged for future comparisons.

### B02: neutral access contracts

`authz/domain/{access,list_scope,principal}.go` now owns `Resource`, `Owners`,
`ListScope`, `ResolveByID`, `OwnerResolver`, `UserContext` and `PermissionRule`.
Enum values, owner comparison, SQL flags, principal JSON and the existing Gin
`"user"` context key are preserved. No legacy type aliases remain. Services,
repositories, pure engine functions and HTTP consumers use the neutral types.
Gin principal accessors remain in `userctx`; body parsing remains in CheckCtx.

The original B02 acceptance wording was broader than its actual prerequisites:
removing every middleware import would also implement B04/B05. Six production
files intentionally retain a concrete HTTP dependency: five engine HTTP builders
(`capability.go`, `entity_create.go`, `entity_update.go`, `kinds.go`, `provide.go`)
for B04, and `authz/service/store.go` for the B05 publisher boundary. No other
service/repository source imports `middleware/rbac` or `userctx` for access data.
This is explicit deferred work, not a claim that the engine is already HTTP-free.

### B03: HTTP tracing adapter

`middleware/tracing` owns `HTTPRootSpan`, `GinSpan`, `FromGin` and
`SetUserOnSpan`; server composition and auth middleware call that adapter.
The shared `tracing` core retains provider lifecycle, context/request identifiers,
span creation and pgx integration without a direct or transitive Gin/middleware
dependency. Span hierarchy/names, status, actor enrichment and log correlation
retain their prior behavior; no new trace-header extraction was introduced.

There are now 116 production internal packages: the one new production package
is the meaningful Gin adapter. The architecture tests are a separate test-only
package. This step fixes dependency ownership; later feature flattening reduces
unnecessary layers. Package count is still not a success criterion.

### Combined validation

- Added 17 test functions, plus six scope compiler cases in an existing test.
  Existing test functions were preserved. Coverage includes neutral principal
  JSON/ACL and Gin accessors, resolver context/cancellation, enum/owner semantics,
  tracing outcomes/lifecycle/log correlation, real auth-to-root enrichment and
  transitive/direct import guards.
- Full normal-tag backend run: 275 top-level tests passed, 16 skipped; including
  subtests, 2,426 pass events and 20 skips. All 355 test functions compile/list
  with the integration tag; the 64 integration-tagged functions were not run.
- Build, vet, pinned lint 2.15.0 (0 issues), race checks across 16 tested packages,
  graph loading, repository policy and whitespace checks passed.
- Wire 0.7.0 was regenerated normally; `wire_gen.go` is byte-identical.
  OpenAPI, frontend SDK, DTOs, SQL queries/configuration/generated sqlc, V1–V15,
  response/error sources and version files remain byte-identical to B01.
  Changed routing/protocol reference files were reviewed for mechanical type
  substitutions and the adapter call migration; route bindings and policies did
  not change.
- Fresh Docker-based SDK generation and DB/HTTP/Electron acceptance were not run.
  No database or runtime stack was started. No push, merge, CI, image build,
  release or deployment was performed. Local logs are outside Git in
  `../local/backend-b02-b03-20261115/` relative to the repository root.

## B06 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `ac33371`, without starting
another implementation branch. All 16 affected constructors now accept their
existing consumer interfaces instead of concrete repositories; auth also accepts
its existing `UserService` interface. Constructors still return concrete service
pointers and retain their original bodies, logger/mapper/validator initialization,
optional hooks and nil handling. Tokenized AST comparison confirmed unchanged
bodies for 176 functions across the 16 production service files.

The existing `policyRepository` was exported as `PolicyRepository` so module
composition can name it in `wire.Bind`; no new interface, wrapper or method was
introduced. Its existing repository-owned principal projections remain unchanged;
removing that data-shape dependency is outside B06. PolicyStore's concrete HTTP
publisher is still deferred to B05.

Fifteen repository-interface bindings live with their module providers. Auth's
user-service binding lives in server composition because the concrete user
provider belongs to a sibling module. Wire 0.7.0 regenerated the same
`wire_gen.go` bytes, preserving the runtime object graph.

Existing session rotation/reuse, RBAC protection/reset, user session revocation,
planning, calendar and task date-constraint tests now construct services through
the real public constructors and existing fakes rather than private struct
literals. Added three test functions with 21 named scenarios: the interface and
concrete-return contracts of all 16 constructors, PolicyStore load failure and
cancellation/default deny, and configuration reads/error/cancellation through an
injected repository. No existing test functions were removed.

Validation: build, vet and the full normal-tag suite passed (278 top-level tests,
16 skipped; 2,450 pass events including subtests, 20 skips). All 358 Test functions
compile/list with the integration tag; 64 integration-tagged functions are not
executed by the normal suite. Full lint 2.15.0 passed with 0 issues; full race
checks passed in all 35 packages with tests. Repository policy and whitespace
checks passed. Frozen API/SDK/DTO/SQL/sqlc/migration/error and version groups
remain identical to B01. No live DB/API/Electron acceptance or
fresh SDK generation is claimed. Local evidence is outside Git in
`../local/backend-b06-20261115/`; no push, merge, release or deployment is performed.

## B04 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `a36d490`. Request-side
builders, parameter decoding, default route definitions, kind schemas and route
check construction now belong to the existing `middleware/rbac` package.
The engine has no direct or transitive dependency on Gin, HTTP middleware or
`userctx`; the architecture guard now includes the engine itself.

`engine.RouteSpec`, `engine.KindInfo` and `engine.ParamInfo` remain plain data
types in their original package to preserve public Swagger definition identities.
The middleware obtains resource/action codes from the existing engine codecs.
Casbin, scope evaluation, inherited view, SQL scope compilation and resolved-fact
assignment authorization remain in the core. Only narrow neutral queries were
exposed to the adapter; no universal request/service-locator interface was added.

Policy administration consumes a focused `RouteCatalog` interface for defaults,
kind metadata and validation. The existing middleware implements it and Wire
binds the same instance at application scope. PolicyStore compiles loaded route
checks through the HTTP adapter before publishing, as before; its concrete
publisher coupling still belongs to B05. Generated Wire was regenerated normally:
only the default factory owner and the catalog argument/binding changed.

Fourteen existing transport/catalog test functions were moved out of engine;
pure matrix, codec, scope and Casbin tests stayed with the core. All 358 existing
test functions were retained. Four new functions cover resolved assignment facts
(9 named cases), project priority/metadata/body handling (15 named cases), all
66 default route definitions, and catalog rejection before repository writes.

Before editing, a disposable in-process HTTP harness recorded 27,720 cases on
`a36d490`: 66 rules × seven principal modes × three ownership configurations ×
20 request variants. It exercises preset/admin/grant/revoke behavior, inherited
view, path/query IDs, owner/parent substitution, missing/null/zero/type/case
variants, comments, priority changes and body restoration. The final adapter
produced identical statuses, error codes/messages, handler execution and restored
bodies for every case. Default definitions and kind schemas were also identical.
This is a local httptest comparison with fake owner resolvers/probes, not a
PostgreSQL or deployed-server test. Harness sources/results remain outside Git.

Validation: build/vet, full normal-tag suite (282 top-level pass, 16 skip; 2,478
pass events and 20 skips including subtests), full race checks in 35 tested
packages, and lint 2.15.0 (0 issues) passed. All 362 Test functions compile/list
with the integration tag; the 64 tagged functions were not executed. All nine
frozen API/SDK/DTO/SQL/sqlc/migration/error/version groups still match B01.
Repository policy and whitespace checks passed. No real DB/API/Electron fixtures
or fresh SDK generation were started. Evidence: `../local/backend-b04-20261115/`.
No push, merge, CI, release, deployment or remote server changes were performed.

## B05 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `d514f1d`. PolicyStore now
accepts the consumer-owned `RoutePublisher` interface. The existing HTTP
middleware prepares and validates checks, returning an infallible publication
action. Wire binds that same middleware instance; regenerating Wire produces no
generated graph changes. No service imports the HTTP middleware, and the
transitive dependency guard now includes `authz/service`.

Reload preserves the existing load order and publication sequence: validate
routes, load principals and ACL rows, validate/publish Casbin, apply prepared
routes, then replace principals. Every fallible step precedes publication.
This remains ordered publication of three snapshots, not a new cross-snapshot
transaction. Startup fallback, TTL recovery, immediate reload and stop semantics
are unchanged; no event bus or additional runtime wrapper was introduced.

The new tests exposed an existing empty-preset bug: Casbin treats an empty filter
field as a wildcard, allowing list-scope and permission-catalog queries to find
unrelated preset rows. With explicit owner approval, empty-preset fallbacks now
deny access. Direct user grants, revokes, database role assignments and admin
bypass remain valid. A regression test failed on the original implementation
before the fix; both backend changelogs record this user-visible correction.

Seven new Test functions add 22 named subcases: six repository-read failure
points, empty/invalid routes, invalid matrix, runtime role/admin/grant/revoke/user
replacement, publication order, startup failure and TTL recovery, stopping the
idle refresh loop, concurrent reads/reloads, and seven empty/known/unknown role
and ACL combinations. All 362 existing Test functions are retained.

Validation: build/vet, full normal-tag suite (289 top-level pass, 16 skip; 2,507
pass events and 20 skips including subtests), full race checks in 35 tested
packages, and lint 2.15.0 (0 issues) passed. All 369 Test functions compile/list
with the integration tag; 64 integration-tagged functions were not executed.
All nine frozen API/SDK/DTO/SQL/sqlc/migration/error/version groups still match
B01. Repository policy and whitespace checks passed. Local HTTP middleware tests
use httptest and fake repositories; no real DB/API/Electron acceptance or fresh
SDK generation is claimed. Evidence: `../local/backend-b05-20261115/`.
No push, merge, CI, release, deployment or remote server changes were performed.

## B07 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `1705689`. Auth and audit
lookup contracts no longer import `user/dto`. Three small neutral views in
`user/domain` separate display/search Identity fields, a passwordless Account
with its assigned preset, and Credentials used only for password verification.
Credentials exclude the hash from JSON; audit's lookup type has neither a hash
nor account permissions. Separate name parts remain available to preserve the
existing audit search behavior.

The existing user service implements these views directly over its current sqlc
repository currency. Auth still has no access to the user repository or SQL.
Login uses credential lookup; refresh uses passwordless account lookup. Public
user DTO mapping and the HTTP auth response stay unchanged. The shared user-row
lookup retains not-found behavior, trace operation names and repository context;
a defensive nil username result is rejected as not found rather than reaching
password verification. The production repository already returns an error for
a missing username.

The existing Wire bindings consume the same user-service instance. Regenerating
Wire produces no graph changes; no adapter object or new provider package was
necessary. Architecture checks protect the cross-module DTO boundary and add
auth service/user domain to the transitive HTTP-dependency guard.

Ten new Test functions add 22 named subcases covering optional/empty name and
preset fields, missing users and lookup failures, empty lists and ordering,
credential serialization, login normalization/password checks/JWT identity,
refresh lookup and rotation ordering, audit search/enrichment, and safe filter
behavior during lookup failure. All 369 existing Test functions are retained;
existing refresh/reuse, cookie-session, password change/reset, account deletion,
session revocation, administrator bootstrap and audit-masking suites still pass.

Validation: build/vet, full normal-tag suite (299 top-level pass, 16 skip; 2,539
pass events and 20 skips including subtests), full race checks in 35 tested
packages, and lint 2.15.0 (0 issues) passed. All 379 Test functions compile/list
with the integration tag; 64 integration-tagged functions were not executed.
All nine frozen API/SDK/DTO/SQL/sqlc/migration/error/version groups still match
B01. Repository policy and whitespace checks passed. HTTP tests use local
httptest Loki endpoints and fake repositories; no real DB/API/Electron acceptance
or fresh Swagger/SDK generation is claimed. Evidence:
`../local/backend-b07-20261115/`. No push, merge, CI, release, deployment or remote
server changes were performed.

## B08 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `6e95371`. Milestone is the
first flattened feature: service implementation, mapping, validation and the
consumer-owned repository interface now live in its feature root. The old
`milestone/service` package is removed and `valitdator.go` becomes `validator.go`.
Root types/constructors use `Service`, `Repository`, `Mapper`, `Validator`,
`NewService` and `NewMapper` to avoid package-name stutter. Normalizing these
identifiers, the package declaration and one constructor comment reproduces all
four original implementation files exactly; business statements are unchanged.

Delivery imports milestone core. DTO, concrete repository, query and sqlc
packages remain separate. Composition stays in parent `project_mgmt/module.go`;
there is no new feature module or compatibility wrapper. Architecture checks
include milestone's transitive dependencies and reject concrete-repository
coupling. Existing constructor/interface guards use the new package identity.
Wire was regenerated normally; normalized provider calls, arguments and order
are identical, with only the moved constructor and import aliases differing.

Seven core Test functions were added and executed at the original service path
before moving them. Two additional HTTP Test functions exercise real handlers,
the core and RBAC middleware over fake repository/owner facts. All nine functions
and 46 named subcases pass before and after the move (55 identical test outcomes).
They cover CRUD, structured validation, malformed/missing dates, absent/null/empty
patch fields, nullable colors, mapper ordering, list/count scope and pagination,
repository error classification, process/project ownership, inherited view,
hidden direct IDs and rejected reparenting. All 379 existing Test functions are
retained. The list tests verify compiled scope forwarding, not PostgreSQL's
execution of the WHERE clauses.

Validation: build/vet, full normal-tag suite (308 top-level pass, 16 skip; 2,594
pass events and 20 skips including subtests), full race checks in 37 tested
packages, and lint 2.15.0 (0 issues) passed. All 388 Test functions compile/list
with the integration tag; 64 integration-tagged functions were not executed.
Fresh Swagger JSON and YAML generated with swag 1.16.6 before/after the move are
byte-identical: 57 paths, 93 operations and 92 definitions. All nine frozen
API/SDK/DTO/SQL/sqlc/migration/error/version groups still match B01. Repository
policy and whitespace checks passed. The local Docker daemon is unavailable;
no real PostgreSQL/API/Electron acceptance or fresh frontend SDK generation is
claimed. Evidence: `../local/backend-b08-20261115/`. No push, merge, CI, release,
deployment or remote server changes were performed.

## B09 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `9420f3a`. The day-type
catalog's service implementation, repository port, mapper and validator now live
in `timesheet/state`, following the milestone pilot. The old `state/service`
package is removed; root names are `Service`, `Repository`, `Mapper`, `Validator`,
`NewService` and `NewMapper`. Normalizing those identifiers, the package name
and one constructor comment reproduces all four original implementation files
exactly. No business statements, default values or error branches changed.

Delivery depends on state core; DTO and repository/query/sqlc remain separate.
Composition stays in parent `timesheet/module.go`. Calendar/absence/resource
packages and state SQL are unchanged. The architecture guard includes state's
transitive dependencies and rejects concrete-repository coupling. Regenerated
Wire has identical provider calls, arguments and order after normalizing the
moved constructor and import aliases.

Six core Test functions were added at the original path before moving them;
two HTTP Test functions exercise real routes, middleware and service over fake
repositories. All eight functions and 54 named subcases pass before and after
the move (62 identical test outcomes). Coverage includes CRUD and conflicts,
idempotent deletion, structured validation, missing rows/database failures,
absent/null/false/true patches, color clearing, empty/ordered catalog results,
and explicit serialization of `is_available: false`. HTTP checks preserve
catalog-only access, denial without capabilities, isolation from unrelated
administration rights, delegated state management and administrator bypass.
All 388 existing Test functions are retained.

Validation: build/vet, full normal-tag suite (316 top-level pass, 16 skip; 2,656
pass events and 20 skips including subtests), full race checks in 39 tested
packages, and lint 2.15.0 (0 issues) passed. All 396 Test functions compile/list
with the integration tag; 64 integration-tagged functions were not executed.
Additionally, 64 existing frontend unit tests pass: 47 shared timesheet/resource
scenarios, including day/week availability, and 17 day-type access checks.
These are focused logic checks, not a browser or Electron acceptance run.
Fresh Swagger JSON/YAML are byte-identical before/after (57 paths, 93 operations,
92 definitions); all nine frozen contract groups still match B01. Repository
policy and whitespace checks pass. The local Docker daemon remains unavailable;
no real PostgreSQL/API acceptance or fresh frontend SDK generation is claimed.
Evidence: `../local/backend-b09-20261115/`. No push, merge, CI, release, deployment
or remote server changes were performed.

## B10 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `116c713`. Task comment
service implementation, repository port, mapper and validator now live in the
feature root; `comment/service` is removed. Delivery, DTO and SQL adapter remain
separate and parent `project_mgmt/module.go` owns composition. Root types and
constructors follow the preceding pilots (`Service`, `Repository`, `Mapper`,
`Validator`, `NewService`, `NewMapper`). Normalizing these names, the package
declaration and one constructor comment reproduces all four original core files
exactly. There is no new HTML transformation or cross-entity comment storage.

The existing validator Test function and its six named cases were moved without
removing assertions. Five additional core Test functions and one HTTP function
were added and executed before the move: six new functions, 33 named subcases.
All 46 original-layout test outcomes (including the existing validator) match
the post-move run. The tests cover unchanged Unicode/Markdown/XSS text through
creation and JSON, the 4,000-rune boundary, validation before parent lookup,
same-task replies, missing/foreign parents, flat thread ordering, timestamps,
repository failures and idempotent deletion. HTTP checks exercise real handlers,
middleware and core over fake repositories/owner facts: hidden/deleted tasks,
foreign comment IDs, deletion by author or permitted owner, author/task spoofing
and same-task replies. Deletion remains authorized from the actual comment's
owner facts; the visible URL task does not grant rights to another comment.

All 396 existing Test functions are retained. Architecture guards include the
comment core and reject concrete-repository coupling. Regenerated Wire preserves
provider calls, arguments and order after normalizing imports and the moved
constructor. Fresh Swagger JSON/YAML before/after are byte-identical (57 paths,
93 operations, 92 definitions); all nine frozen contract groups still match B01.

Validation: build/vet, full normal-tag suite (322 top-level pass, 16 skip; 2,695
pass events and 20 skips including subtests), full race checks in 40 tested
packages, lint 2.15.0 (0 issues), repository policy and whitespace checks pass.
All 402 Test functions compile/list with the integration tag; 64 tagged functions
were not executed. Additionally, 32 existing frontend Markdown/XSS and native
discussion unit tests pass. The local Docker daemon is unavailable: no real
PostgreSQL/API, cross-user browser/Electron/PDF XSS acceptance or fresh frontend
SDK generation is claimed. The guarded XSS end-to-end harness is unchanged.
Evidence: `../local/backend-b10-20261115/`. No push, merge, CI, release, deployment
or remote server changes were performed.

## B11 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `52516ce`. Assignment service,
repository port, mapper and validator now live in the feature root;
`assignment/service` is removed. Delivery, DTO and SQL adapter remain separate;
parent `project_mgmt/module.go` owns composition. Root types and constructors
follow the preceding pilots (`Service`, `Repository`, `Mapper`, `Validator`,
`NewService`, `NewMapper`). Normalizing these names, the package declaration and
one constructor comment reproduces all four original core files exactly.

Nine Test functions were added, with 55 named subcases; all 402 existing Test
functions are retained. The first 56 assignment test outcomes passed against the
original service layout and match the final run; additional HTTP list/deny cases
bring the final assignment run to 64 passing outcomes. Core tests cover CRUD,
positive IDs/quantity, absent/null/zero patches, mapping/order, identical
list/count scope filters and pagination, repository failures and idempotent
deletion. Existing lookup-error classification is preserved, including update's
conversion to assignment-not-found; this structural step does not change errors.

HTTP tests exercise real middleware, handlers and core with fake repositories
and owner resolvers: own/all/no-access rules, foreign IDs for read/update/delete,
foreign tasks within an owned process, create-time task visibility, task/resource
replacement, common-owner checks including administrator, and list scope,
owner-filter and pagination forwarding. They do not execute SQL list predicates.
Repository tests use the actual SQL adapter over a request-scoped fake pgx.Tx
with no fallback pool: create/find/find-by-key/update/delete preserve the context,
arguments and errors without committing or rolling back the request. Duplicate
create reads the existing pair in that same transaction, preserving its stored
quantity, and propagates lookup errors. These tests do not simulate database
constraints or prove real transaction rollback.

Architecture guards include the assignment core and reject concrete-repository
coupling. Regenerated Wire preserves provider calls, arguments and order after
normalizing imports and the moved constructor. Fresh Swagger JSON/YAML before
and after are byte-identical (57 paths, 93 operations, 92 definitions); all nine
frozen contract groups still match B01. SQL, generated sqlc, migrations, DTOs,
versions and published changelogs remain unchanged. In particular, the database
owner-equality guard and assignment cleanup triggers are untouched; update-time
owner equality continues to rely on that database guard where applicable.

Validation: build/vet, full normal-tag suite (331 top-level pass, 16 skip; 2,759
pass events and 20 skips including subtests), full race suite and final focused
assignment race checks, lint 2.15.0 (0 issues), repository policy and whitespace
checks pass. All 411 Test functions compile/list with the integration tag; 64
tagged functions were not executed. The local Docker daemon is unavailable, so
real PostgreSQL/API acceptance, including TestAssignmentOwnerInvariant and
owner-change cleanup/rollback, was not executed. No browser/Electron acceptance
or fresh frontend SDK generation is claimed. Evidence:
`../local/backend-b11-20261115/`. No push, merge, CI, release, deployment or remote
server changes were performed.

## B12 implementation ledger — 2026-11-15

Continued on `refactor/backend-access-tracing` after `f555c73`. Project service,
repository port, mapper and validator now live in the feature root;
`project/service` is removed. Delivery, DTO and SQL adapter remain separate;
parent `project_mgmt/module.go` owns composition. Root types and constructors
follow the preceding pilots (`Service`, `Repository`, `Mapper`, `Validator`,
`NewService`, `NewMapper`). Normalizing these names, the package declaration and
one constructor comment reproduces all four original core files exactly.

Eleven Test functions were added, with 66 named subcases; all 411 existing Test
functions are retained. All 88 pre-move outcomes from the project and planning
packages match the final run after normalizing the moved core identifiers
(including the new repository-failure test name). The new tests contribute 77
passing outcomes. Core tests cover owner normalization, nullable ownership,
responsible-person retention/replacement/clearing, color clearing, Unicode code,
calendar dates across year boundaries, zero priority, invalid patches before
writes, auto-created counts and noncritical feedback failures, list/count scope
and pagination, error classification and idempotent deletion. Existing update
lookup-error classification is preserved rather than changed in this move.

HTTP checks exercise real middleware, handlers and core with fake repositories
and ownership probes. They cover owned/foreign/unrelated projects; process and
task descendant access; process-only related access; probe failures; list scope;
read/update/delete by ID; creation and ownership transfer; and the director's
priority-only grant, including denied metadata, mixed, empty and delete requests.
The process/task descendant facts are supplied by the test probe, not queried
from PostgreSQL. Planning tests verify forwarding self/down/process-project/all
scopes and preserving project order, owner/responsible, code, color, dates and
priority, plus empty/error results. They do not execute SQL visibility predicates.

Repository checks use the actual SQL adapter over a request-scoped fake pgx.Tx
without a fallback pool. Create/find/update/delete/count/auto-create feedback
preserve the request context, query arguments and errors without finalizing the
transaction. Duplicate project codes still produce conflict rather than silently
returning an unrelated existing project. These checks do not prove real database
constraint, cascade, trigger or rollback behavior.

Architecture guards include the project core and reject concrete-repository
coupling. Regenerated Wire preserves provider calls, arguments and order after
normalizing imports and the moved constructor. Fresh Swagger JSON/YAML before
and after are byte-identical (57 paths, 93 operations, 92 definitions); all nine
frozen contract groups still match B01. SQL, generated sqlc, DTOs, migrations,
versions, published changelogs, optimistic revision guards and replay middleware
remain unchanged; no new schema or public API is introduced.

Validation: build/vet, full normal-tag suite (342 top-level pass, 16 skip; 2,836
pass events and 20 skips including subtests), full race suite, lint 2.15.0
(0 issues), repository policy and whitespace checks pass. All 422 Test functions
compile/list with the integration tag; 64 tagged functions were not executed.
The local Docker daemon is unavailable, so real PostgreSQL/API acceptance,
including project date-shift/cascade, auto-create and optimistic/idempotent
integration scenarios, was not executed. No browser/Electron acceptance or fresh
frontend SDK generation is claimed. Evidence: `../local/backend-b12-20261115/`.
No push, merge, CI, release, deployment or remote server changes were performed.

## B13 implementation ledger — 2026-11-16

Continued on `refactor/backend-access-tracing` after `da80cdc`. Process service,
repository port, mapper and validator now live in the feature root;
`process/service` is removed. Delivery, DTO and SQL adapter remain separate;
parent `project_mgmt/module.go` owns composition. Root types and constructors
follow the preceding pilots (`Service`, `Repository`, `Mapper`, `Validator`,
`NewService`, `NewMapper`). Normalizing these names, the package declaration and
one constructor comment reproduces all four original core files exactly.
The existing append-order integration fixture imports the relocated constructor;
its scenarios and assertions are unchanged.

Twelve Test functions were added, with 70 named subcases; all 422 existing Test
functions are retained. All 99 pre-move outcomes from process and planning tests
match the final run. The new tests contribute 82 passing outcomes. Core checks
cover creation/read/deletion, Unicode titles, nullable mapping, dates across year
boundaries, owner/responsible changes and responsible=0 clearing, color clearing,
project reassignment and retention of sort_order during ordinary patches,
validation before writes, list/count scope and pagination, failure propagation
and idempotent deletion. Reorder checks reject empty, duplicate, incomplete and
foreign ID sets, require the complete project group, retain requested order and
propagate both lookup and write failures.

HTTP checks exercise real middleware, handlers and core with fake repositories
and parent/related ownership probes. They cover project-owner management of a
foreign-owned process, process-owner management, inherited project viewing
without mutation rights, direct access by ID, moves into owned/foreign/missing
projects, ownership transfer restrictions, responsible/date updates, creation,
list scope and whole-project reorder authorization. Fixture parent/probe facts
model the visible project; they do not execute database ownership queries.
Planning smoke verifies owner/responsible, title/color/dates, process order and
project grouping, plus forwarding all/project-owner/process-owner/inherited
view scopes. It consumes prefiltered fake rows, not SQL visibility predicates.

Repository checks use the actual SQL adapter over a request-scoped fake pgx.Tx
with no fallback pool. Find/update/delete preserve context, query arguments and
errors; update forwards the changed owner, responsible, project and dates to the
unchanged SQL. Create joins that transaction, locks before the append query and
stops on lock/insert errors. Reorder joins the same transaction, executes mark
then apply with the requested IDs and stops on either failure. None of these
methods finalizes a transaction owned by the request. These tests do not prove
real database cleanup, rollback, concurrent locking or unique-index behavior.

Architecture guards explicitly include the process core and reject concrete
repository coupling. Regenerated Wire preserves provider calls, arguments and
order after normalizing imports and the moved constructor. Fresh Swagger
JSON/YAML before and after are byte-identical (57 paths, 93 operations, 92
definitions); all nine frozen contract groups still match B01. SQL, generated
sqlc, DTOs, migrations, versions, published changelogs and revision/replay
middleware remain unchanged. Owner-change assignment cleanup and descendant
date shifts remain the responsibility of their existing database triggers.

Validation: build/vet, full normal-tag suite (354 top-level pass, 16 skip; 2,918
pass events and 20 skips including subtests), full race suite and final focused
architecture race check, lint 2.15.0 (0 issues), repository policy and whitespace
checks pass. All 434 Test functions compile/list with the integration tag; 64
tagged functions were not executed. The local Docker daemon is unavailable:
real PostgreSQL/API acceptance, including TestAssignmentOwnerInvariant cleanup,
date/cascade shifts, concurrent append/reorder and revision/replay integration,
was not executed. No browser/Electron acceptance or fresh frontend SDK generation
is claimed. Evidence (started before midnight): `../local/backend-b13-20261115/`.
No push, merge, CI, release, deployment or remote server changes were performed.

## B14 implementation ledger — 2026-11-16

Continued on `refactor/backend-access-tracing` after `5fd3978`. Task dependency
service, repository port, mapper, validator and pure constraint helpers now live
in the feature root, together with the four dependency types and catalog helpers
from `domain/models.go`. Both `task_dependency/service` and its small `domain`
package are removed. The root package is named `taskdependency`; DTO and SQL
adapter boundaries remain unchanged. Composition stays in the parent module.
Normalizing internal names, package declarations, the removed domain qualifier,
formatting and the constructor comment reproduces all six original core files.

Task's consumer-owned `ConstraintSource` file is byte-identical. Wire binds the
relocated `*taskdependency.Service` to that existing port. Neither production
core imports the sibling feature or its concrete SQL adapter; a new architecture
guard rejects either direction. Regenerated Wire preserves provider calls,
arguments and order after normalizing imports, the constructor and its generated
local variable name. No task scheduling API or parallel service interface was
introduced.

All five existing constraint/validator Test functions were moved with their
assertions retained; all 434 pre-existing Test functions remain. Eleven new Test
functions add 67 named subcases and 78 passing outcomes. All 104 pre-move outcomes
from dependency and task suites match the final run. New core checks cover
self-links, invalid IDs/types, missing endpoints, different processes, subtasks,
duplicate edges, cycle rejection and incompatible current dates before writes.
Each fs/ss/ff/sf create boundary accepts equality. Type changes substitute only
the target edge, retain the other incoming constraints, preserve endpoints and
propagate lookup/constraint/date/write failures. List order, empty mapping,
foreign-edge rejection and idempotent/error deletion behavior are preserved.

The real task and dependency services are tested together through ConstraintSource:
for all four types, equal boundaries persist and an earlier constrained date
rejects the update without changing the stored task. A constraint read failure
also blocks persistence. Existing task date/title-only guard tests remain intact.
HTTP checks use real middleware, handlers and core with fake repositories/owner
facts: view versus update permissions, hidden tasks, foreign nested edge IDs,
URL task binding against a spoofed body task_id, self-link rejection, missing
edges and idempotent deletion. Repository checks use the actual SQL adapter over
a fake request-scoped pgx.Tx without a fallback pool, covering create/find/type
update/delete, endpoint/duplicate/cycle probes and task dates, including argument
order, errors and leaving commit/rollback to the request owner. They do not
execute SQL graph traversal or prove real transactional rollback.

Fresh Swagger JSON/YAML before and after are byte-identical (57 paths, 93
operations, 92 definitions); all nine frozen contract groups still match B01.
SQL, generated sqlc, DTOs, migrations, versions, published changelogs and
revision/replay middleware are unchanged. Inclusive date comparisons and the
existing database graph constraints/triggers retain their previous behavior.

Validation: build/vet, full normal-tag suite (365 top-level pass, 16 skip; 2,996
pass events and 20 skips including subtests), full race suite in 51 tested
packages, lint 2.15.0 (0 issues), repository policy and whitespace checks pass.
All 445 Test functions compile/list with the integration tag; 64 tagged
functions were not executed. The local Docker daemon is unavailable, so real
PostgreSQL/API graph, trigger, constraint and revision/replay acceptance was not
executed. Graph/probe fixtures are not a substitute for SQL integration tests.
No browser/Electron acceptance or fresh frontend SDK generation is claimed.
Evidence: `../local/backend-b14-20261116/`. No push, merge, CI, release, deployment
or remote server changes were performed.
