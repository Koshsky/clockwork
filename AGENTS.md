# Clockwork contributor instructions

Read the relevant service's AGENTS.md before editing it. Code comments,
documentation and commit messages use English; product UI is bilingual RU/EN.

`main` is the only permanent branch. Work in short-lived topic branches and merge
into main after checks. Do not recreate dev/staging Git branches. Deployment tags
in Docker Hub are independent from Git branches.

Keep the Go and npm projects separate: run Go commands in backend/ and npm commands
in frontend/. Do not edit generated Go or TypeScript manually. Existing migration
files and published versions are immutable. Record new release versions in both
service changelogs before building and publishing images.

The migration keeps service versions, Docker names, the Go module path, Electron
appId/userData and existing runtime behavior stable. Offline separation is a
subsequent project, not part of this repository move.

Never commit env files, database dumps, plugins, personal seed data, local tracker
credentials or installed dependencies. A single root .gitignore governs both
services. Service .dockerignore files remain necessary for their build contexts.

Run make check or the focused service checks appropriate to the change. This is
not an Arcadia checkout; ya commands and monorepo-wide formatting do not apply.
Deployment, archival of source repositories and image-tag promotion require the
user's instruction; a normal push does not deploy anything.

## Repository layout

- `backend/`: Go API, authorization, embedded SQL migrations and backend tests.
- `frontend/`: Vue application, generated API client and frontend tests.
- `frontend/desktop/`: Electron wrapper using the shared frontend.
- `deploy/`: gateway configuration for the optional container stack.
- `docs/`: migration decisions, validation reports, development notes and README media.

## Local development

Use Node.js 22.12+, the Go version declared in `backend/go.mod`, Docker Compose
and Air. Install Air or pass its executable with `make AIR=/path/to/air backend`.

```sh
cp .env.example .env
# Replace the local password and JWT placeholders before starting services.
npm --prefix frontend ci
make infra
make backend
# In another terminal:
make frontend
```

The frontend serves `http://localhost:5173` and proxies same-origin `/api/v1` to
the native backend on port 8080. Root make targets export `.env`; the Go backend
does not load it automatically. See `docs/development.md` for existing-data reuse,
container configuration, API client generation and desktop packaging.

## Validation

```sh
make check
```

Use the service-level AGENTS.md files for focused checks. Backend lint is a
separate check: run `golangci-lint run ./...` in `backend/` with the pinned version
specified there. Integration tests need an explicit local test configuration;
never use production credentials, personal seeds or a shared deployment.

CI runs on pull requests into `main` and pushes to `main`. `scripts/ci.py`
selects checks from the complete push diff or PR merge-base diff, including both
paths of renamed files. Missing history selects all checks rather than silently
skipping them.

The caller ci.yml invokes three local reusable workflows from the same commit:
ci-backend.yml, ci-frontend.yml and ci-common.yml. They form separate Backend,
Frontend and Common checks paths. Each group depends only on its own independent
change detector (backend-changes, frontend-changes or common-changes), so all three
paths run in parallel. The separate predecessors keep their graph dependencies
distinct; reusable workflow files alone do not create separate graph cards.
All detectors use the same tested filter implementation and complete Git history.
Only the caller owns push/PR triggers and concurrency; the reusable workflows
accept workflow_call only and do not start independent runs or release images.

- Backend application/build inputs select Go build/vet/tests and lint.
- Frontend application/build inputs select frontend checks/tests/build.
- Generated schema/client inputs and scripts/generate-api.sh select the API check.
- README, AGENTS, changelogs and developer documentation do not select application
  jobs. Markdown/text imported from frontend/src or served from frontend/public
  remains an application input.
- Workflow, scripts, root configuration and deployment-only changes do not select
  backend/frontend jobs. The common group always runs repository policy checks,
  script tests and workflow syntax validation; its API job uses the API filter.

Keep `All checks` unconditional. It waits for all three detectors and groups and
validates successful detection and common checks, successful selected service
groups and skipped unselected groups. Reusable workflow outputs expose each nested job's
result, including the optional API check, so a failed, cancelled, missing or
unexpectedly skipped nested check cannot produce a green gate.
Do not add path filters to workflow triggers. Tracked filenames must not contain
line separators, which repository policy rejects.

Run tooling tests without frontend dependencies:

```sh
python3 -m unittest discover -s scripts/tests -v
```

## Manual Docker releases

PRs may combine code, dependency, configuration, version and changelog changes.
The common policy job checks canonical versions changed by the PR against the
highest published stable Docker Hub tag, using the same one-step SemVer rule as
the manual release. Git merge-base identifies changes introduced by the PR;
neither main's version nor a moving latest/stable tag is the bump baseline.
Unchanged versions require no registry request. A missing/malformed canonical
version, invalid bump, occupied destination tag or registry failure blocks CI.
This PR check does not build or publish Docker images and does not reserve a tag.
The manual release rechecks Hub before building and again before publishing, so
an intervening publication cannot silently overwrite an existing version.

Docker release runs only through Actions → Docker release → Run workflow, from
`main`. Choose frontend, backend or both. PRs, pushes and ordinary CI never start
this workflow. It does not edit, commit or bump source versions and never deploys
a server or moves stable. The stable tag is promoted manually, outside Actions.

Before launching, the developer commits the new version and finalized release
notes in a short-lived branch, then merges it into main:

- Frontend canonical version: frontend/package.json. npm manages its lockfile;
  Electron package metadata is generated from that version during packaging.
  Finalize both frontend changelogs when preparing a release.
- Backend canonical version: backend/VERSION (plain X.Y.Z). Keep the backend
  changelogs and Swagger metadata current using the documented generators.
- Published changelog blocks and migration SQL remain immutable. Release-note
  correctness is maintained by the developer; there is no additional changelog,
  migration or application-test gate in the manual release workflow.

The pre-build version gate compares each selected file with the numerically
highest published stable vX.Y.Z tag in its Docker Hub repository, across every
page of tags. Exactly one step is allowed: 1.4.1 → 1.4.2, 1.5.0 or 2.0.0.
Equal versions, downgrades, skipped increments, missing resets (1.5.1), leading
zeroes, prerelease/build suffixes and a v prefix in source files are rejected.
Network/auth/rate-limit failures stop the release rather than guessing a baseline.
The initial backend/VERSION is 1.4.3, matching the existing Hub image, not a new
release. The initial frontend version is likewise already published: neither
service can be released until the developer prepares its next valid version.

Configure repository secrets DOCKERHUB_USERNAME and DOCKERHUB_TOKEN, with write
access to the selected koshsky image repositories. The local Docker login is not
available on GitHub runners. Tokens never enter source files or release reports.

The workflow validates all selected versions before any build, builds linux/amd64
images with their file version injected as APP_VERSION, then rechecks the
published baseline and absence of destination tags before any push. It publishes
vX.Y.Z tags first; only after all selected images are published does it assign
latest to their exact registry digests, without rebuilding. Registry HEAD reads
avoid treating delayed Docker Hub listings as proof that a version tag is absent.
Runs are serialized; a changed latest digest stops promotion before
any moving tag is updated. Each tag is verified against the published digest.

Each run retains a release-plan artifact with source SHA, versions, built image
IDs, published digests, previous latest digests and completed promotions. There
is no atomic update spanning two Docker repositories. A partial push or promotion
may require completing or restoring latest from the recorded digests; do not
rebuild or overwrite an already published version. A fresh full run deliberately
rejects that occupied version. The workflow never performs an automatic rollback.

## Contribution workflow

All changes start in a short-lived topic branch from the latest `main`. Open a
pull request into `main`, run the required checks, merge and delete the topic
branch. Show the result and wait for the owner's explicit approval before merging;
green checks do not replace that approval. Do not commit changes directly to
`main`. There are no permanent `dev` or `staging` Git branches; Docker deployment
tags are managed separately.

Prepare cohesive, reviewable PRs rather than separate PRs for incidental fixes.
Squash intermediate corrections into one reviewed commit before merging. Rewrite
already published main history only when the owner explicitly requests it.

See CONTRIBUTING.md for branch commands. Keep the root README focused on the
product; development commands and internal process information belong here.

## Manual server deployment

`Deploy production` is workflow_dispatch-only on main and separate from releases.
It consumes published vX.Y.Z images and repository-owned production configuration;
it never publishes images or moves latest/stable. See docs/deployment.md for the
verified server contract, production environment secrets, recovery and tests.
Keep external volume/network names immutable unless a separately reviewed server
migration explicitly changes that contract. Do not run production deployment as
part of validating a deployment PR. Changes here require owner's approval before
merging, and a separate instruction before running the workflow.
