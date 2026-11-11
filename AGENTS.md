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

## Contribution workflow

All changes start in a short-lived topic branch from the latest `main`. Open a
pull request into `main`, run the required checks, merge and delete the topic
branch. Do not commit changes directly to `main`. There are no permanent `dev`
or `staging` Git branches; Docker deployment tags are managed separately.

See CONTRIBUTING.md for branch commands. Keep the root README focused on the
product; development commands and internal process information belong here.
