# Optional private backend metrics

Metrics are disabled in both supplied backend configurations. No Prometheus,
exporter process, scraper, background sender or user session is required to run
Clockwork. Existing logs and tracing work independently. Local operation/receipt/audit
observations are available independently of metrics and are also exported when
this endpoint is enabled; see [Operation diagnostics](operation-diagnostics.md).

## Enable locally or on a trusted private network

Use the backend configuration selected by `CONFIG_PATH`:

```yaml
metrics:
  enabled: true
  address: "127.0.0.1:9091"
```

After a separately authorized restart, a Prometheus-compatible scraper can read
`http://127.0.0.1:9091/metrics` from the same network namespace. The listener is
separate from the API, JWT/session handling, pprof and the default HTTP mux.
Only GET/HEAD on `/metrics` is supported. There is no API route serving metrics.
The existing Caddy examples explicitly return 404 for `/metrics*` on their normal
web listener. This change does not publish a Docker port or start monitoring.

The address must contain a literal loopback, RFC 1918 private or IPv6 ULA address
and a port. Hostnames, public IPs and wildcard binds (`0.0.0.0`, `::`, `:9091`)
are rejected. Port zero is useful only for an ephemeral local test listener.
Direct peer addresses must also be private/loopback; forwarding headers and
browser session headers cannot grant access. There is no user-session dependency.

For a private remote scraper, select a real private address belonging to the
backend's network namespace and restrict access at the host/container firewall.
The endpoint uses HTTP inside that trusted network: private addressing is a
network boundary, not authentication or encryption. Never forward it through
the public gateway or publish it on a public interface. An SSH tunnel or an
existing authenticated private monitoring gateway can provide remote access.
In Docker, loopback belongs to the container; a host scraper cannot reach that
address automatically. An explicitly configured scraper can share the backend's
network namespace, or connect to an explicitly bound private container address.
No optional Compose topology is deployed by enabling this setting.

A valid configuration does not contact a scraper. A metrics-port bind failure
produces a safe local warning and leaves the business API available; the API
claims its port before the metrics listener starts, including when ports conflict; fix the
configuration/port before expecting scrapes. A malformed/public binding fails
configuration instead of silently exposing data. Stopping the application drains
the auxiliary server using the caller's deadline. Header reads, scrape collection
and writes have 2/3/5 second bounds; concurrent collection is limited to one, and
response compression is disabled. Collection failures never alter business data.

## What is measured

| Metric | Meaning |
| --- | --- |
| `clockwork_http_requests_total` | Completed HTTP transport attempts |
| `clockwork_http_request_duration_seconds` | Handler-chain duration in seconds |
| `clockwork_http_requests_in_flight` | Current application attempts, all routes combined |
| `clockwork_http_label_overflow_total` | Attempts aggregated after the detailed-label budget was exhausted |
| `clockwork_build_info{version}` | One canonical backend release label; frontend versions remain local to About/Diagnostics |
| `clockwork_process_start_time_seconds` | Instrumentation start time, Unix seconds |
| `go_*` | Standard Go collector: memory, goroutines and GC statistics |
| `clockwork_db_pool_available` | A pool is attached; **not database readiness** |
| `clockwork_db_pool_{acquired,idle,total,max}_connections` | Pool usage and configured capacity |
| `clockwork_db_pool_acquires_total` | Successful pool acquires |
| `clockwork_db_pool_acquire_seconds_total` | Total duration of successful acquires, including uncontended ones |
| `clockwork_db_pool_waits_total` | Successful acquires that waited |
| `clockwork_db_pool_wait_seconds_total` | Their cumulative waiting duration |
| `clockwork_db_pool_canceled_acquires_total` | pgx cancellation counter, which includes timeouts |
| `clockwork_db_pool_acquisitions_total{outcome}` | All acquire attempts split into success, timeout, canceled and error |

HTTP count and duration share `route`, `method`, `status`, `outcome`. They are
recorded once in the existing access-summary path using its single timer.
The duration covers application middleware/handlers, not delivery of every byte
to the client. Responses, transaction behavior and retry/idempotency rules are
unchanged. A retry is another HTTP attempt, not another committed business
operation. Logical-operation observations use the separate `clockwork_outcomes_total` counter.

Controlled HTTP outcomes are `success`, `redirect`, `validation`, `denied`
(401/403), `conflict` (409), `not_found` (404), `rate_limited` (429), `timeout`,
`canceled`, `server_error`, and `panic`. Cancellation/deadline context overrides
an otherwise successful HTTP status. Recovery marks a panic even when response
headers were already written with status 200; metrics and the summary remain
failures without pretending that the wire status could be changed. A panic has
priority over context/status classification.

Normal validation, RBAC denial and conflict are not infrastructure failures;
429 and client cancellation are separate signals. Select `server_error`, `panic`
and relevant `timeout` observations deliberately when defining an installation's
API error indicator. Do not count all 4xx as application outages. Registered
`/api/v1/health`, `/api/v1/ready`, `/health`, `/ready` and `/metrics` are excluded
from application counters, latency and in-flight measurements. Swagger remains
outside the existing application access middleware. Unknown paths, including
unregistered probe-like URLs, are counted as `unmatched` rather than hidden.

Pool samples read `pool.Stat()` once per collection and never issue SQL. The pgx
acquire hook observes completions without changing the request context, tracing,
connection ownership or retry behavior. Pool counters include startup work.
A timeout/cancellation is distinguished from ordinary acquisition errors; raw
errors, SQL, user/database names and DSNs are never metric labels.

## Cardinality, resets and low traffic

Only registered, application-authored route templates enter labels. Object IDs,
query strings, arbitrary URLs/methods/errors, user/request/trace IDs and business
payloads are absent. Up to 256 authored templates are retained for normalization.
Detailed HTTP label combinations are capped at 160 per process; further new
combinations share one fixed `other/OTHER/other/other` series. Existing detailed
series continue to update. The overflow counter exposes the loss of detail; the
total attempt count is preserved. Other dimensions also use fixed vocabularies.

Duration buckets are fixed at 0.01, 0.1, 0.5, 2 and 10 seconds, plus +Inf.
Native histograms, exemplars and user-configurable buckets are not enabled.
The saturation test exported **1501 samples** including Go/pool metrics on the
validated toolchain, below the 2000-series example budget and leaving space for
O06. Its combined saturation test measured **1636 samples**, including all 108
bounded stage/outcome pairs and both audit queues. This is not a promise for arbitrary future collectors or versions: keep the
budget test when extending instrumentation. Registries belong to application
instances and do not register on Prometheus's global default registry.

Counters reset on process restart; use Prometheus `rate()`/`increase()` on each
original counter before aggregation so observed resets are handled. The process
start metric helps identify a restart. Scrape failure is not a counter reset or
proof of zero errors. With no application requests, request families can be
absent; after the first request they remain cumulative. An idle service can have
zero request rate, and a missing scraper/insufficient samples yields no useful
rate. Check scrape `up`, process start and traffic before interpreting missing
latency/error data as health. Percentiles are not useful evidence under tiny or
empty samples; no universal SLO is introduced here.

## Verification

```sh
cd backend
go test ./internal/metrics ./internal/server ./internal/database ./internal/config
go test -race ./internal/metrics ./internal/server ./internal/database
go test ./internal/metrics -run '^$' -bench BenchmarkHTTPMetrics -benchmem
```

The optional database test needs `METRICS_TEST_DATABASE_URL` pointing to a
**disposable loopback** database named `clockwork_metrics_*`. It tests a real
single-connection pool, waiting, timeout, cancellation and release without
installing schema or using application data. A missing variable skips only that
test. Never use a deployed database or personal dataset.

From the repository root, an optional gateway test uses already cached Caddy
images, no network, no published ports, no host/data mounts and tmpfs storage:

```sh
DOCKER_CONTEXT=colima CLOCKWORK_METRICS_DOCKER_TESTS=1 \
  python3 -m unittest discover -s scripts/tests -p test_metrics.py -v
```

Use the appropriate existing local Docker context; no VM/context change is needed.
No application images are built, published or deployed by these tests.

Local measurement on 2026-11-19: Apple M3 Pro, Darwin/arm64, Go 1.27.2,
GOMAXPROCS=2, three 300ms samples. A warmed Begin/Complete pair measured
3.12ns / 0 bytes / 0 allocations when disabled and 66.4–66.7ns / 3 bytes /
1 allocation when enabled. This excludes access logging, wall-clock timer calls,
HTTP, SQL, the first label allocation and scraping. It is a microbenchmark, not
an application p95/CPU/RAM guarantee; full workload acceptance belongs to O14.

References: [Prometheus instrumentation](https://prometheus.io/docs/practices/instrumentation/),
[Go client](https://pkg.go.dev/github.com/prometheus/client_golang/prometheus).

O11 adds one bounded build-info sample to the earlier O05/O06 counts (1502/1637 on the same toolchain); registries still stay below the 1900-sample scrape cap.
