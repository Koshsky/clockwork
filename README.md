# Clockwork

Resource and process planning for managers: projects, Gantt schedules, resource
availability, timesheets and reporting. The shared Vue client runs in the browser
and in Electron; the backend is written in Go.

## Repository layout

- `backend/` — API, authorization, embedded SQL migrations and Go tests.
- `frontend/` — Vue application, generated API client and frontend tests.
- `frontend/desktop/` — Electron wrapper using the same frontend.
- `deploy/` — development infrastructure and optional container stack.
- `docs/` — migration, development and release instructions.

## Development

`main` is the only permanent branch. Make all changes in short-lived branches
created from the latest `main`, then open a pull request into `main`. Run the
required checks before merging and delete the branch after the merge. Do not
commit changes directly to `main` or create permanent `dev` or `staging` branches.
See [Contributing](CONTRIBUTING.md) for commands and conventions.

Use Node.js 22.12+ and the Go version declared in `backend/go.mod`. Docker Compose
is needed for PostgreSQL and optional supporting services.

```sh
cp .env.example .env
# Set local passwords and JWT keys before starting services.
make infra
make backend
# In another terminal:
cd frontend
npm ci
npm start
```

The frontend serves `http://localhost:5173` and proxies `/api/v1` to the native
backend on port 8080. See [development](docs/development.md), including reuse of
existing data and isolated test configuration.

## Checks

```sh
make check
```

See the service-level `AGENTS.md` files for focused commands. Integration tests
need an explicit local test configuration; real deployment credentials and seeds
are never part of this repository.

## Source repositories

Clockwork starts with a new initial commit containing the current source trees.
Historical commits, Git tags and GitHub Releases remain in the original projects:

- [ERP frontend](https://github.com/Koshsky/erp-frontend)
- [ERP backend](https://github.com/Koshsky/erp-backend)

See [migration decisions](docs/monorepo-migration.md) for source revisions and
compatibility choices. The original repositories can be archived after cutover.
Docker images and published versions remain available in Docker Hub as
`koshsky/erp-frontend` and `koshsky/erp-backend`.
