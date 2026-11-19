# Liveness, readiness and the optional external probe

`GET /api/v1/health` retains its existing 200 envelope (`data.status: ok`) and
performs no database query. Existing web/Electron connectivity/offline detection
continues to use it. A database outage does not turn liveness into an offline
signal that hides server-side failures.

`GET /api/v1/ready` returns 200 with `data.status: ready`, or 503 with
`data.status: not_ready`. Both have an empty `error` object and `Cache-Control:
no-store`. The response exposes no schema number, DSN, SQL, error text, user,
credentials or deployment inventory. This is an operational endpoint like health,
not a generated business API operation.

Readiness checks that the configured application PostgreSQL connection works and
has exactly one clean `schema_migrations` row at the latest embedded core version.
Missing history, dirty/older/newer versions, multiple rows, SQL failure and pool
failure are not ready. Deployment-specific Flyway plugin history is not inspected
or changed. There is no write, migration, repair, superuser login or external call.
The application DB role needs SELECT on its existing migration history table.

One SQL query has a 500 ms context bound, at most one concurrent refresh and a
one-second local result cache, including negative results. Concurrent probes during
a refresh return 503 instead of waiting or starting more SQL. A caller-cancelled
query cannot poison the shared cache. Cache state is not durable; a restart begins
with a fresh check. This is bounded evidence, not an instantaneous transaction
health guarantee. Missing telemetry/Loki/metrics/Grafana/OTLP does not participate.

Health and readiness are registered before application/public/per-user token
buckets. Probe traffic neither consumes a user's budget nor gets blocked by a
busy public bucket. Existing business/auth rate limits remain. The normal request
middleware still provides safe logs/correlation; registered probe routes remain
excluded from business HTTP metrics. No production Compose check changes here.

## Independent demo observation

`scripts/probe-demo.py` is an optional one-shot external observation. Its example
`deploy/observability/probe.example.json` is disabled. Run the disabled example:

```sh
python3 scripts/probe-demo.py --config deploy/observability/probe.example.json
```

After a separately authorized setup, copy the configuration outside Git and enable
it on an existing machine/runner **outside** the application VPS. Choose its
schedule, responder and notification channel with the owner. It needs no admin
credential, account, synthetic browser, telemetry endpoint or subscription.
Observe a missing/late checker result separately; a checker on the failed VPS
cannot establish that VPS's availability. O12 describes debouncing/recovery.

The checker validates a credential-free HTTPS origin, verifies TLS and hostname,
reads only `/api/v1/ready`, caps the response at 4 KiB and never follows a redirect.
It reports controlled status, reachability, HTTP status and certificate seconds
remaining, without URL, body or certificate identity. A successful HTML SPA is
not a ready API. A parent process bounds the entire worker to six seconds,
including DNS; a timeout is unknown, never healthy. There is no diagnostic upload.
HTTP is allowed only for explicit loopback fixtures. With HTTP, TLS is reported
as not configured; it is never represented as a verified certificate.

Exit 0 = ready; 1 = observed failure; 2 = disabled/configuration failure/unknown.
An unready API with working HTTPS differs from an unreachable endpoint. An expired
or unverifiable certificate is a connection failure; do not bypass verification.
Actual TLS expiry policy is left to the installation/owner. No schedule or new
server has been created by delivering these files.

## Local checks

Backend readiness tests cover SQL state on a disposable PostgreSQL database,
deadline/concurrency/cache, privacy, cancellation and independence from liveness
and application rate buckets. The PostgreSQL test runs only with an explicit
`ERP_READINESS_TEST_DSN` pointing at an isolated disposable database; it creates
and drops its own `schema_migrations` fixture and must never use a real deployment.

```sh
python3 -m unittest discover -s scripts/tests -p test_probe.py -v
```

The external test uses a separate loopback HTTP fixture, not erp.koshsky.ru. It
checks static-up/API-not-ready, failed/recovered, oversize, connection loss and the
parent deadline. Existing browser acceptance covers SPA/chunks/navigation without
introducing a permanent synthetic login monitor.
