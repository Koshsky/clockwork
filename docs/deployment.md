# Manual production deployment

This workflow updates the existing `/opt/erp` stack on `erp.koshsky.ru`. It does
not bootstrap a replacement database, build images, publish releases, or move
`latest` / `stable`. It is deliberately separate from **Docker release**.

## Verified server contract

The read-only inventory on 2026-11-14 found Compose project `erp`, services `db`,
`erp`, `frontend`, `caddy`, `loki`, PostgreSQL 16, clean schema version 14, backend
1.4.3 and frontend 1.6.3 (both using `stable`). Docker Compose was 5.6.1.

These names are an explicit safety boundary:

| Data | Existing Docker volume |
| --- | --- |
| PostgreSQL | `erp-infra_db_data` |
| Caddy certificates and account | `erp-infra_caddy_data` |
| Caddy configuration state | `erp-infra_caddy_config` |
| Audit journal | `erp_loki_data` |

The external network is `erp_app-network`, subnet `172.18.0.0/16`. The backend
trusts only Caddy at its reserved `172.18.0.5/32` address for proxy headers;
other peers cannot supply a forwarded client IP. The deploy refuses an address
collision. Custom assets stay in
`/opt/erp/assets/custom`. Production configs live in `deploy/production/`;
root `compose.yaml` remains the optional development stack.

All four volumes and the network are external. Missing volumes, different live
mounts, unexpected subnet, custom PGDATA, empty/incompatible PGDATA, or unsafe migration history
abort before replacing containers. The workflow never creates an empty DB as a
fallback, deletes volumes, removes orphan services, prunes images, or upgrades
PostgreSQL across major versions. PGDATA must be `/var/lib/postgresql/data`
in both the existing and proposed containers. Migration history must contain
exactly one clean row; missing, multiple and dirty rows all fail. The application
image must be linux/amd64.

The production configuration matches the inventoried backend/proxy/Loki
configuration. Redis and tracing stay disabled on this small VPS. Loki is reached
through Docker only: the old unauthenticated public port 3100 is not published
by the managed Compose. Caddy remains the sole public entrypoint, on 80/443.

## One-time GitHub setup

Create an environment named `production`. Restrict deployment branches to `main`
and, where the GitHub plan supports it, configure a required reviewer. A manual
workflow alone is not a reviewer gate. Only trusted maintainers should have the
ability to modify/run this workflow: it executes as root on the target host.

Add the following **environment secrets**:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | `erp.koshsky.ru` |
| `DEPLOY_USER` | `root` |
| `DEPLOY_PORT` | SSH port, optional (default `22`) |
| `DEPLOY_SSH_KEY` | Dedicated OpenSSH private deploy key, without passphrase |
| `DEPLOY_KNOWN_HOSTS` | Verified SSH host key line(s), including `[host]:port` for a non-default port |
| `DEPLOY_APP_ENV_JSON` | Application environment object described below |

Generate and authorize a dedicated deployment key using a trusted administrator
machine. Keep the existing personal SSH key unchanged. Verify host key
fingerprints through an existing trusted SSH connection; do not trust a fresh
`ssh-keyscan` response without comparing its fingerprint. The workflow enforces
host key checking, disables agent forwarding/agent identities, and uses only the
configured key. Root access and Python 3, Docker Engine, Compose v2.30+ are required.

`DEPLOY_APP_ENV_JSON` is one JSON object, not a shell script or dotenv file:

```json
{
  "DATABASE_NAME": "existing database name",
  "DATABASE_USER": "existing database user",
  "DATABASE_PASSWORD": "existing database password",
  "ADMIN_PASSWORD": "bootstrap administrator password",
  "JWT_SECRET_KEY": "existing signing key",
  "JWT_REFRESH_KEY": "existing legacy refresh key if configured"
}
```

Preserve existing values when moving them into GitHub. Unknown keys, missing
required values, invalid JSON and NUL bytes are rejected. JSON escaping supports
quotes, spaces, Unicode, newlines and literal dollar signs. DATABASE_URL is built
with percent-encoded credentials; Compose values are quoted and dollar-escaped.
Never paste credentials into a workflow input, PR, command line or chat.

The DB name/user/password are compared with the running database container.
Changing them here is rejected: PostgreSQL bootstrap variables do not rotate an
existing user's password. `ADMIN_PASSWORD` creates a missing admin only. Changing
JWT keys invalidates sessions; do not do it accidentally during this migration.
An existing legacy refresh key cannot be silently omitted. JWT_SECRET_KEY must
contain at least 32 UTF-8 bytes, matching backend startup validation.

Credentials are transferred over verified SSH stdin. Runner key files use mode
0600 and are removed afterward. Server requests, backups, rendered Compose and
logs stay in a root-only directory; files containing secrets use mode 0600.
Public configuration files are mode 0644 for the non-root application container.
No secret-bearing deployment bundle is uploaded as an Actions artifact. Docker
error output is retained in the private server log, never forwarded to Actions.

## Deploy

1. Merge the reviewed deployment/configuration PR. Independently publish the
   desired images through **Docker release**, if they do not already exist.
2. Actions → **Deploy production** → **Run workflow**, branch `main`.
3. Optionally specify published backend/frontend tags, both in `vX.Y.Z` form.
   Empty inputs use `backend/VERSION` and `frontend/package.json`. `latest`,
   `stable`, prereleases and unversioned images are rejected. Choose a tested
   application/config combination; the workflow does not infer compatibility
   between arbitrary old application versions and new configuration.
4. Follow the phase messages. Success requires Compose readiness, expected
   running image IDs, a real PostgreSQL query with a clean migration state,
   and public HTTPS frontend/API checks. The health endpoint alone is insufficient.

GitHub serializes deployments and does not cancel an active one when another is
queued. The server also holds an exclusive lock, protecting against independent
runners. Missing managed directories are created; unexpected symlinks/files cause
failure. File replacement is atomic and identical files keep their timestamps.

Each bundle records its Git source SHA, selected versions, pulled image digests,
private environment and configurations. Images are pinned before updating the
stack; each resolution is saved immediately, so a failed second pull cannot
cause a retry to resolve the first tag again. Repeated requests reuse their
recorded digests even if a registry tag moves. Infrastructure image digests were taken from the current server. Updating
an infrastructure image requires a reviewed Compose change, not a new pull of a
moving infrastructure tag.

Before each change, the worker validates Compose and Caddy, checks disk space,
creates a PostgreSQL custom-format dump, verifies its table of contents, archives
configuration/custom assets, and archives both Caddy volumes directly from their
validated host mountpoints. This also works if Caddy was stopped by a failed run.

If Loki configuration changes, the worker stops Caddy first and then the backend
with a 30-second shutdown timeout before touching Loki. After activating Compose,
it starts Caddy alone with `--no-deps` before reconciling any other container.
This reserves Caddy's fixed IP before Docker can allocate it to a dynamically
addressed service, including PostgreSQL and Loki. The gateway may temporarily
return 502 while its upstreams are stopped or being replaced.

The worker then reconciles only PostgreSQL and Loki and waits for the real Loki
`/ready` HTTP endpoint before starting the application. Caddy's early start never
starts its backend/frontend dependencies. The readiness probe
uses curl from the pinned Caddy image on the existing network, with no published
ports or application credentials. Unchanged Loki does not require a traffic pause;
its HTTP readiness is still checked before application reconciliation and again
before reporting success. A failed readiness check never starts the paused
application, and retrying can complete the same staged reconciliation.

The final `up --no-build --pull never --wait` recreates
services whose image/config changed while retaining mounted data. Immutable,
content-addressed bind sources make config-only changes visible to Compose too.
The backend applies its embedded migrations during startup; Flyway adoption and
PostgreSQL major upgrades are separate administrator operations.

A successful repeated request with unchanged files and runtime container IDs
checks readiness without pulling/recreating services or making another backup.
Runtime drift triggers reconciliation. The initial transition may recreate all
services once because image references, mount paths and Compose ownership become
explicit. Expect a short interruption; this is not a zero-downtime deployment.

## Interrupted or failed deployment

The server worker runs detached from SSH, with closed SSH descriptors. Losing a
response or cancelling the Actions waiter does **not** stop a migration or imply
failure. Actions calculates the request ID before sending it, and can poll that
same request even if the start acknowledgement was lost. A retry attaches to a
running request instead of starting a duplicate. There is no automatic DB rollback.

As root, inspect the recorded ID printed by Actions:

```sh
request=/opt/erp/.clockwork/requests/REPLACE_WITH_PRINTED_ID
cat "$request/status.json"
tail -n 100 "$request/private.log"
docker compose -p erp -f /opt/erp/docker-compose.yml ps
```

The status records the phase, images and backup location. Never paste the private
log or rendered Compose into a public issue; they can contain credentials.
Resolve the actual error, verify no worker is still running, then retry the same
bundle. The server lock rejects another deployment while one is active. A killed
or reboot-interrupted worker releases the OS lock; retrying reconciles the
existing containers using the same pinned images. `previous-compose.yml` retains
the original Compose even across failed retries.

Rollback is a separate reviewed operation. Changing back an image/Compose does
not roll back database migrations. Decide whether the previous binary supports
the new schema before reverting it; a dump restore requires stopping writers and
an explicit data-loss decision for writes since that dump. Never run
`docker compose down -v`, edit migration history, or rerun Flyway as recovery.

Backups and bundles intentionally have no automatic destructive retention policy.
Copy verified backups off the VPS, test full restoration regularly, and remove
old backups/images only after reviewing what is still needed. A table-of-contents
check is not a substitute for restoring the dump. Loki data remains in its
existing volume; this deployment does not claim a consistent online snapshot of
the audit journal. Keep a separate journal/host backup policy. Readiness gating
prevents the planned Loki restart from accepting mutations before audit is ready;
it does not make the existing asynchronous audit sender a durable outbox during
unrelated runtime outages.

The disk budget includes twice the database and ancillary source sizes (configs,
assets and both Caddy volumes), archive overhead and an additional 2 GiB reserve
for running services. Ancillary archives also check the reserve while streaming,
so source growth after estimation stops backup before exhausting that reserve.
An unavailable budget aborts before activation.

## Validation

```sh
python3 -m unittest discover -s scripts/tests -v
CLOCKWORK_DEPLOY_DOCKER_TESTS=1 python3 -m unittest discover -s scripts/tests -p 'test_deploy*.py' -v
python3 scripts/check-repository.py
```

The opt-in Docker test creates a random test project and tests secret fidelity,
unchanged-container reuse, configuration-driven recreation with retained data,
and dump restoration. It removes only resources belonging to that new project.
Common checks enables this test in CI; it does not build application images or
connect to production. Application/source filters remain unchanged.
