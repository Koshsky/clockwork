# Flyway to embedded golang-migrate: administration runbook

This is a planned maintenance operation. No production deployment is performed
by adding this document. Rehearse against a restored production backup before
scheduling the real cutover. Use the same immutable backend image for rehearsal,
adoption and deployment. Never use a moving `staging` tag as the sole identifier.

## 1. Prepare on the operator's machine

1. Build/release the reviewed backend `dev` changes through the normal image
   pipeline. Record the resulting image digest. The backend image embeds core
   SQL; do not separately copy migrations or install Flyway/Java on the server.
2. Run `bash scripts/test-migration-upgrade.sh` from the backend repository.
3. Restore a recent server backup into a separate local PostgreSQL 16 database.
   Run the commands below against that copy first. Keep deployment plugins and
   their data present; do not replace the copy with an empty core-only schema.
4. On a native development machine, build and invoke the same commands directly:

   ```sh
   go build -o build/service ./cmd/service
   # Set DATABASE_URL privately to the restored local database, not production.
   ./build/service migrate status
   ./build/service migrate adopt-flyway --dry-run
   ./build/service migrate adopt-flyway
   ./build/service migrate up
   ./build/service migrate status
   ```

Do not put passwords in shell history, commit `.env`, or print `docker inspect`
output containing environment variables. Existing application databases also
need explicit adoption; a genuinely empty database needs only `migrate up`.

## 2. Inventory the server before changing it

Connect as the authorized operator (`root` for the current deployment), then:

```sh
cd /opt/erp
docker compose ps
```

Identify the backend, database and Flyway service names in the deployed compose
file. Examples below use `erp`, `db`, and `flyway`; adjust to the actual file.
Record the old image digest, compose files, configuration and environment-file
locations privately. Identify every Flyway runner: compose, CI/CD, cron and
systemd. Stop/disable those runners for the cutover, including automatic restarts.

Read the history without modifying it:

```sh
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT installed_rank, version, type, script, checksum, success
FROM flyway_schema_history ORDER BY installed_rank;
SQL
```

The migration command uses the database user's current schema/search path and
the standard table name `flyway_schema_history`. Verify that it is the deployed
history table. A custom history table/schema needs an explicit reviewed
adaptation first. Unknown successful SQL plugins are allowed; failed/non-SQL
history and changed core checksums require investigation, not `repair` guessing.

## 3. Freeze writes and take a recoverable backup

Enable maintenance at the ingress; stop every backend replica and background
writer. Stop any running Flyway job and prevent scheduled jobs from starting.
For a compose deployment with these service names:

```sh
docker compose stop erp flyway
umask 077
backup_dir="/opt/erp/backups/migrate-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup_dir"
cp -p docker-compose.yml config.yaml .env "$backup_dir/"
cp -a migrations "$backup_dir/migrations"
docker inspect --format '{{.Image}}' erp > "$backup_dir/old-backend-image-id.txt"
docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$backup_dir/database.dump"
docker compose exec -T db pg_restore -l < "$backup_dir/database.dump" > "$backup_dir/contents.txt"
```

Check command exit statuses, dump size and restore the dump into a separate
throwaway database to prove recovery. Keep a private copy of deployment config
and the old image digest alongside it. Do not proceed with a failed backup.

## 4. Prepare the deployment file and image

Remove the external `flyway` service and the backend's
`depends_on: flyway: condition: service_completed_successfully` from the server's
compose configuration. Preserve other dependencies, DB volumes and configuration.
Disable equivalent CI/cron jobs. Point the backend image at the reviewed immutable
digest and pull that service without starting it:

```sh
docker compose pull erp
```

Review `docker compose config --services` and the file diff. Avoid dumping fully
expanded compose configuration into shared logs because it can contain secrets.
The new backend still needs its usual `.env`, config mount and Docker network.
Migration commands need only `DATABASE_URL`, and no migration directory mount.
Do not run `docker compose down -v`, `make reset`, or recreate the production DB.

## 5. Validate, adopt and migrate with HTTP still stopped

`run --no-deps` is essential: it avoids starting old dependency jobs or the API.
The service entrypoint remains `/app/service`; arguments below invoke its CLI:

```sh
docker compose run --rm --no-deps erp migrate status
docker compose run --rm --no-deps erp migrate adopt-flyway --dry-run
docker compose run --rm --no-deps erp migrate adopt-flyway
docker compose run --rm --no-deps erp migrate status
docker compose run --rm --no-deps erp migrate up
docker compose run --rm --no-deps erp migrate status
```

For V1–V9 plus any successful unknown SQL plugins, preview/adoption reports
`baseline: 9`; the intermediate native state is version 9, dirty false. `up`
executes V10 and ends at version 10, dirty false.

For an existing successful V10, preview/adoption reports `baseline: 10`; `up`
executes no SQL. The server inspected during development already had V10, but
always inspect the target again rather than assuming that historical state.

The dry run must not create `schema_migrations`. The actual adoption creates
that table and records one clean native version. Every old Flyway row, including
unknown plugin records, remains unchanged. Retain the old SQL/history as archives.

## 6. Start and verify

```sh
docker compose up -d --no-deps erp
docker compose logs --tail=100 erp
docker compose run --rm --no-deps erp migrate status
```

Check the deployment's usual health/API endpoint, login, projects/processes/tasks
and plugin-dependent behavior. Confirm version 10/dirty false and unchanged
Flyway history. Then restore ingress traffic and background writers. Startup
also runs `up`, so later releases apply their embedded pending core migrations
before exposing the API. Maintain backups and the maintenance procedure for
future releases; long-running migrations need an appropriately planned rollout.

## Failure and rollback

- Adoption rejection: leave the old history intact, keep maintenance active and
  investigate the precise checksum/gap/failed-record message. Do not force a
  guessed version or delete unknown plugin history.
- SQL failure: golang-migrate leaves `schema_migrations.dirty=true`. The API must
  remain stopped. Inspect database logs and the failed SQL. Fix through a reviewed
  recovery procedure or restore the pre-cutover backup; this CLI intentionally
  offers no generic force/dirty-clear operation.
- Rollback after native SQL ran: restoring only the old backend image does not
  roll back the schema. Restore the verified backup and matching old deployment
  while all writers are stopped, or use a separately reviewed forward repair.
- Never reactivate Flyway against the migrated database. Its preserved table is
  historical; native V10 and later migrations are not written there.

Unknown plugins are not proven compatible by reading their history: they may
change a table/trigger used by V10. The restored-database rehearsal and application
checks are required to detect deployment-specific incompatibilities. Synthetic
local plugins exercise preservation and numbering, not every possible plugin.

## Current erp.koshsky.ru training deployment

The read-only inspection found `/opt/erp/docker-compose.yml`, backend service
`erp`, database `db`, Flyway service `flyway` (container `migrator`) and ingress
`caddy`. Backend and frontend both currently reference their `staging` tags.
Update **only the backend** for this exercise; preserve the frontend image.

The locally verified backend build is:

```text
koshsky/erp-backend:staging-migrate-20261109-c4663cdf1590
koshsky/erp-backend@sha256:c4663cdf1590a303cb4d46e61e45dd354621710320ab77e6455c4d5fc45b15cd
```

Use the digest in the compose `erp.image` field. Replace its Flyway dependency
with database readiness, leaving environment, config mount, healthcheck and
networks unchanged:

```yaml
  erp:
    image: koshsky/erp-backend@sha256:c4663cdf1590a303cb4d46e61e45dd354621710320ab77e6455c4d5fc45b15cd
    # Keep all the other existing erp settings.
    depends_on:
      db:
        condition: service_healthy
```

Delete the entire `flyway:` service block. Keep `/opt/erp/migrations` as an
archive. Back up the original compose file before editing it. To make the
maintenance window unambiguous, stop the ingress too while using the **original**
compose file (before removing its Flyway service):

```sh
cd /opt/erp
docker compose stop caddy erp flyway
```

Take/verify the database backup from section 3, edit the compose file, pull the
pinned image and follow section 5 exactly. An observed successful V10 means
baseline 10, not 1022 even if the highest plugin/seed version is 1022.
After the final status reports version 10/dirty false:

```sh
docker compose up -d --no-deps erp
docker compose exec -T erp wget -q -O - http://127.0.0.1:8080/api/v1/health
docker compose up -d --no-deps caddy
curl --fail --silent https://erp.koshsky.ru/api/v1/health
```

Keep caddy stopped if migration or health verification fails. Inspect logs and
use the recovery section; do not resume Flyway to troubleshoot native migrations.
