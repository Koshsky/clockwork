# Diagnose a problem without a monitoring stack

1. Ask for the service versions and a safe request ID/error code from Diagnostics
   or About. A manual web report has no object contents or credentials. Never ask
   for a full Electron profile, database, vault, request payload or password.
2. The operator checks the matching `request_id` in the local structured server
   logs, near the reported time. Use the fixed event/error/outcome codes; a trace
   ID is useful only if tracing was explicitly enabled and that trace was sampled.
   No trace or missing metric is proof neither of success nor of failure.
3. Check `/api/v1/health` versus `/api/v1/ready` for a suspected database problem.
   Liveness can stay 200 during a database outage. Readiness is bounded schema/DB
   evidence, not a reason to repair a volume or replay migrations automatically.
4. For an unsaved edit, distinguish optimistic UI, queued/unknown, accepted commit,
   receipt recovery, conflict and rejection. HTTP retries are not multiple logical
   commits; a lost reply can be resolved by the existing durable receipt protocol.
   See [operation outcomes](operation-diagnostics.md). Do not discard a queue to
   make a warning disappear.
5. For slowness, use an explicit reproducible time window/workload. Compare API
   duration, DB-pool pressure and the local diagram workload before enabling more
   integrations. Browser history is deliberately not a profiler or traffic log.
6. For disk/RAM/TLS/deploy trouble, use [local demo checks](demo-operations.md) and
   [response notes](demo-alerts.md). Preserve application/audit/backup/certificate
   data. Do not automatically prune volumes or extend retention to hide a fault.

Logs and controlled request IDs work without Grafana, Loki queries or a trace
store. Existing audit is a separate RBAC-protected business journal; diagnostic
Grafana gets no credentials or datasource for that journal.

## The two optional dashboards

The [separate monitoring example](optional-monitoring.md) provisions only:

- **Clockwork — HTTP**: target scrape state, backend release, completed transport
  attempts/second, server/panic/timeout fraction, p95 latency, attempt volume,
  controlled HTTP outcomes and in-flight attempts.
- **Clockwork — runtime and delivery**: allocated Go memory, goroutines, pool
  connections/waits, known logical-operation outcomes, audit enabled/pending and
  known audit-delivery failures. These counters are not a durable audit log.

The server release comes from the one-series `clockwork_build_info{version}`
metric. It is updated before startup from the same effective version as About;
unknown/noncanonical input stays `unknown` and never becomes a free label.
Frontend versions stay in each user's About/Diagnostics, not a central client
registry. There are no user/device last-seen panels or automatic client uploads.

Both dashboards use only the provisioned private Prometheus datasource, no Loki,
Tempo or conditional empty drill-down panel. No connection to the Grafana API,
log store or collector is required to run the application. To use an existing
OTLP receiver, follow [tracing](tracing.md); do not assume a head-sampled trace was
kept for every failure.

## Interpret the numbers carefully

Panels use five-minute windows and units. HTTP throughput counts attempts;
403/409 are explicit outcomes, not server failures. The error ratio includes only
server/panic/timeout outcomes. A positive observed request denominator with no
error series is a known zero fraction; an absent/zero denominator is **No data**,
not zero-percent errors. An unhealthy scrape suppresses that ratio and latency
rather than showing a stale reassuring result.

A rate needs at least two samples. A quiet/new instance can therefore legitimately
show No data. Check the request volume panel before trusting p95: fixed buckets
(10 ms, 100 ms, 500 ms, 2 s, 10 s) and low volume limit precision. Do not turn this
into a universal SLO or SLA. No data, disabled audit and a measured zero counter
are different observations.

Counters reset on process restart; Prometheus rate/increase handles a reset inside
the selected range. The unit PromQL fixtures check no target, zero denominator,
409, real server-error fraction, counter reset and down-scrape behavior against
the pinned engine. Runtime acceptance checks actual Grafana provisioning/API and
evaluates every query on a synthetic private target. It does not fabricate a
production traffic measurement or give Grafana access to business data.

```sh
DOCKER_CONTEXT=colima CLOCKWORK_MONITORING_DOCKER_TESTS=1 \
CLOCKWORK_MONITORING_TEST_DIR=/absolute/private/docker-shared/test-directory \
  python3 -m unittest discover -s scripts/tests -p test_dashboards.py -v
```

Use an existing local Docker context on Linux. The PromQL test has no network,
a read-only fixture and bounded temporary storage; it never contacts the demo.
