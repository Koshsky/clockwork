# Optional backend tracing

Clockwork works without a trace receiver. Both supplied configurations disable
tracing; enabling it is an operator decision. No JavaScript SDK, collector or
trace database is required by the production stack. Audit/business events keep
their existing storage and access rules.

## Enable an existing OTLP/gRPC receiver

Edit the backend configuration file selected by `CONFIG_PATH` and restart the
backend during a separately authorized maintenance operation:

```yaml
tracing:
  enabled: true
  exporter_endpoint: "traces.example.org:4317"
  insecure: false
  ca_file: "" # Optional path inside the backend container, mounted read-only.
  service_name: "erp-backend"
  sampler_ratio: 0.1
```

The endpoint is an ASCII host (punycode for international names) and port, including `[IPv6]:port` if needed, without a
scheme, URL credentials, path or query. `TRACING_ENDPOINT` overrides this endpoint
for an explicitly selected environment. There is no implicit Jaeger destination.
The ratio must be finite and between 0 and 1; zero records no new root spans.

TLS is the default, uses the system trust store and hostname verification, and
requires TLS 1.2 or newer. `ca_file` adds a private CA; there is no option to skip
certificate verification. Missing or invalid CA files fail configuration rather
than silently weakening transport security. For bearer authentication, supply
`TRACING_AUTH_TOKEN` through your existing private environment/secret mechanism.
For Compose, explicitly pass this variable to the backend service through a private
override or environment mapping; a host shell variable alone is not injected
into containers. Mount a private CA read-only if one is needed. The token
is ignored in YAML and sent only as OTLP gRPC authorization metadata. Never put
it in a URL, a committed file or a support report. Empty means no authentication.

`insecure: true` is an explicit development escape hatch for an isolated,
trusted receiver, for example `jaeger:4317` in a private local Docker network or
`localhost:4317` for a host-run backend. This mode sends unencrypted traces;
never expose it over the Internet. A token or `ca_file` together with insecure
mode is rejected. The existing local Jaeger service can still be selected
explicitly; no service is added to production Compose.

Clockwork owns the gRPC connection and explicitly sets destination, credentials,
headers, sampler, span and queue limits. Ambient `OTEL_*` settings do not select
another destination, add resource identities/headers, override TLS verification
or raise those limits. Do not use those variables as a parallel configuration
interface. No credentials or tracing headers are injected into the audit or HIBP
HTTP clients, and browsers/Electron require no new configuration.

## Trace boundaries and privacy

Completed HTTP spans use a route template (including `unmatched`) and a normalized
HTTP method, result status and server request ID. SQL spans contain only operation
and affected-row count. Errors use controlled codes; raw SQL, query parameters,
payloads, authorization/cookies, comments and user identities are omitted, as
specified in [Diagnostic data](diagnostic-data.md). Resources contain only
`service.name` and the backend's canonical `service.version` (including build-time
version injection). SDK error reports contain a static message and code rather
than receiver-controlled text or credential-bearing configuration.

Public requests are untrusted. A single, valid, bounded W3C `traceparent` becomes
a **link** on a new server-owned root, not its parent. The backend chooses the new
trace ID and sampling decision. The link retains only the external trace/span
IDs, without sampled flags or vendor state. Repeated, oversized or invalid
headers are ignored. `tracestate` and `baggage` are never extracted; existing
baggage is cleared at this boundary. An already attached, trusted in-process
parent is preserved. HTTP → middleware → service → SQL spans share the resulting
local context. The explicit remote-parent sampler also uses the local ratio as
defense in depth.

Each network attempt ends its own request span. Offline waiting never creates a
multi-day server span. A caller may provide the same traceparent on a retry to
link both attempts to its original operation; Clockwork does not introduce a new
client SDK for this. Existing idempotency/operation receipts continue to decide
whether business work executes. Export retries resend the same completed spans;
they neither reopen spans nor execute mutations or audit events again. OTLP
transport is best-effort, not exactly-once delivery: receivers can see duplicates
when their acknowledgement is lost.

Head sampling decides before the request outcome is known: it cannot guarantee
that every failed request is retained. Keep request/error logs available even
when tracing is enabled. Sampling is not a rate limiter.

## Resource and failure budget

| Bound | Value |
| --- | --- |
| Completed span queue | 512, nonblocking; excess spans are dropped |
| Maximum export batch | 64 spans |
| Periodic export interval | 2 seconds |
| Export deadline, including transient retries | 3 seconds per batch |
| Retry backoff | Starts at 200 ms, capped at 1 second, within the export deadline |
| Shutdown flush | At most 5 seconds, or the caller's earlier deadline |
| Span attributes / string value | 16 / 256 characters |
| Span events / links | 4 / 4 |
| Attributes per event or link | 16 |

These are fixed SDK bounds, not an absolute process-memory cap: concurrent active
requests and application objects also consume memory. No blocking export option
is enabled on the request path. Valid configuration starts without waiting for a
receiver. Unavailability, certificate failure or receiver rejection loses traces
and produces safe diagnostic warnings, without failing business operations.
Shutdown attempts to flush; an earlier deadline can discard pending spans.
Disabled tracing creates no provider/exporter, reads no CA file, opens no export
connection and does not validate unused export settings.

## Local verification

The normal backend tests run disposable loopback OTLP/gRPC receivers; no Docker,
external trace service, production credentials or shared database is used:

```sh
cd backend
go test ./internal/tracing ./internal/middleware/tracing ./internal/idempotency ./internal/config
go test -race ./internal/tracing ./internal/middleware/tracing ./internal/idempotency
go test ./internal/tracing -run '^$' -bench BenchmarkRequestTracing -benchmem
```

Tests cover a trusted TLS CA and bearer metadata, rejected certificates,
ambient-setting isolation, shutdown flush, transient retry, unavailable/blocked
receivers, disabled mode, queue/span bounds, W3C links, internal hierarchy and
idempotent business retry. An optional operator smoke test may connect this
configuration to their own receiver, invoke a harmless API read, find its route
and version, then disable tracing again. This implementation does not deploy a
trace store or run that test against any live installation.

References: [OpenTelemetry Go exporters](https://opentelemetry.io/docs/languages/go/exporters/),
[head sampling](https://opentelemetry.io/docs/concepts/sampling/),
[W3C trace-context security](https://www.w3.org/TR/trace-context/#security-considerations).

A local microbenchmark on 2026-11-18 (Apple M3 Pro, Darwin/arm64, Go 1.27.2,
GOMAXPROCS=2; three 300 ms samples per mode) measured one facade span:
disabled 34.6–37.2 ns / 72 bytes / 2 allocations; unsampled 159–165 ns /
168 bytes / 3 allocations; sampled with a no-op batch exporter 422–430 ns /
973 bytes / 4 allocations. This measures SDK/facade overhead only, without
HTTP, database, receiver or network work; it is not an application latency SLO.
