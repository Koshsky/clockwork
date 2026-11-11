# Development

Copy .env.example to .env in the repository root and replace its local-only
placeholders. The Go backend does not load .env itself: root make targets export
it before starting Air. Alternatively export the variables explicitly and run
`go run ./cmd/service` in backend/. Use Node.js 22.12+ and Go 1.27+.

`make infra` starts PostgreSQL, Loki, Jaeger and Redis. `make backend` runs native
Air from backend/ (install Air first or set `make AIR=/path/to/air backend`); `make frontend` starts Vite from frontend/. Install dependencies
with `npm ci` in frontend/. The web API URL must remain same-origin `/api/v1`.

For the optional container stack run `docker compose --profile stack up --build`
after configuring .env. The gateway is http://localhost:8088. Backend and frontend
images are independently versioned. This is not a production deployment runbook.

The default Compose project is erp-dev, matching the existing local development
volume namespace. Inspect existing containers/volumes and keep the established
project name before switching an existing workspace. A different project name or
userData directory can make existing data appear absent. Do not run a second
PostgreSQL on port 5432 while the old stack is active. The migration does not stop
or replace the existing native/tmux stack automatically.

Core SQL migrations are embedded in the backend. Existing Flyway databases require
explicit `migrate adopt-flyway` after backups; no Flyway container runs here. Keep
plugins, real seeds and database backups outside Git. Use the existing server
runbook for administrative adoption, never reset a shared database.

Integration scripts use ERP_TEST_ENV to select a local test env file where
supported, or local/dev.env in this repository. Copy a private local test env there
if needed; no credentials or current data are included. Run integration scripts
only against disposable local fixtures. Never point them at production.

Desktop builds still use frontend/desktop/build-portable.sh. It regenerates the
web bundle and checks embedded versions; appId and the installed userData path
remain stable. No native installer is built as part of the repository move.

Regenerate the client with `scripts/generate-api.sh --write`; verify it with
`scripts/generate-api.sh --check`. The pinned Docker generator reads
backend/docs/swagger/swagger.yaml. Schema-version comments are ignored by the
contract comparison; TypeScript declarations and implementation must match.
