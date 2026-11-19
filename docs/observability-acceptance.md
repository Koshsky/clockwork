# Local observability acceptance

Validated on 2026-11-19 in `docs/observability-o01`, on top of the O01–O08 work.
Product versions remain backend 1.6.0 / frontend 2.2.0; these are unreleased branch
changes. No image, installer, release, deployment, production configuration,
notification channel, timer or server state was changed by this acceptance.

## Delivered scope

- O01 fixes the self-hosted/product, optional integration and demo boundaries.
  Safe local logs, readiness and reports require no monitoring server or SDK.
- O09 adds private native journals, a previewed explicit report and read-only
  queue aggregates. Main owns correlation and per-context boundaries. Diagnostics
  cannot mutate/replay business commands or introduce another outbox.
- O10 provides an explicit, private, resource-limited Prometheus/Grafana profile.
  O11 provisions two focused read-only dashboards with explicit no-data behavior.
- O12 provides disabled, bounded alert evaluation with debounce, stale-data and
  recovery handling. No channel or schedule is selected or activated.
- O13 keeps liveness stable and provides cached/bounded DB/migration readiness
  plus an independent external HTTPS/TLS probe. A frontend HTML 200 is not ready.
- O14 checks failure isolation, privacy, budgets and an operator quickstart. It
  reuses the existing behavioral suites rather than duplicating all scenarios.

## Behavioral and failure evidence

| Area | Checks actually performed |
| --- | --- |
| Backend | All Go package tests; focused race tests for diagnostics, server, migrations, metrics, tracing, operation and audit paths; strict lint and architecture guard |
| Database readiness | Disposable local PostgreSQL 16: current/missing/dirty/empty/wrong/duplicate migration state, missing history and closed pool; no production DSN |
| Frontend | 1,809 unit tests, 441 Node contracts, typecheck and zero-error lint; actual Electron source IPC |
| Web | Actual Chrome, isolated HTTP fixtures: sign-in, request IDs, navigation, two tabs, Gantt days/weeks, PDF capture/download, Ctrl+S/Ctrl+P/print iframe, handled PDF failure/retry, offline/recovery and cross-tab identity reset |
| Electron | Actual macOS Electron with isolated profile/preload/renderer and unchanged CSP: two windows, explicit preview, exact saved bytes, server/context switch, no backend traffic |
| Queue/log failure | Durable SQLite writes with an unavailable diagnostic directory; quota/retention; partial/tampered lines; restart/scope isolation; sleep/active time; failed observers; lost response → receipt with one execution; 403/409; native cancel, stale preview and existing-file protection |
| Optional export | Disabled registry/exporter creates no dependency; unavailable OTLP receiver, bounded queue/batch/attributes/shutdown and safe error handling covered by tracing tests; private metrics access and cardinality tests |
| Monitoring example | Real pinned Prometheus/Grafana on local Colima Linux/aarch64: no profile starts no services, no published ports, auth, scrape/no-data, dashboard provisioning/all 16 queries, restart persistence and ENOSPC in a separate 64-KiB tmpfs; fixtures removed |
| PromQL/alerts | Real pinned promtool: absent/zero, 409, server-error ratio, counter reset, failed scrape; alert debounce/recovery/stale/retry without any real notification |

Native tests now run in the existing Windows/macOS/Linux CI runner as well as the
fast frontend contract command. This local run is **not** Windows/Linux graphical
installer acceptance. Source Electron tests are not signed/packaged release tests.
Eight opt-in fixture suites in the general Python run remain explicitly skipped;
the relevant new readiness/monitoring/PromQL suites were run separately, not
represented as covered by that skipped invocation.

## Budget methodology

Host measurements used macOS 26.7.1/arm64, Go 1.27.2 (`GOMAXPROCS=2`)
and Node 26.13.0; optional container tests used Colima Linux/aarch64.
The O01 numbers are workload guardrails, not SLA/minimum machine requirements.
All samples are local, short, warm workloads; none is a seven-day production peak.
Small negative differences mean measurement noise, not a speedup claim.

Backend: `TestObservabilityBudget` serializes the same synthetic planning response
with 2,000 tasks through Gin. Baseline has the handler only; local adds real
request IDs, tracing facade, the production safe ContextHandler/release metadata,
JSON log encoding into a sink and recovery; optional
adds private metrics and 10% OTLP sampling with an unreachable loopback receiver.
Five rotated passes per mode contain 300 measured requests after warm-up. Reported
p95 is the median of those five p95 values; raw ranges remain in the test log.
CPU uses Go runtime user+GC seconds/request, normalized to **10 requests/second**,
not all machine CPU. Heap initialization includes all routers and business fixture,
so it is a conservative fixture-inclusive value, not total process RSS or per-OS
capacity. This is transport/encoding instrumentation, **not a SQL/RBAC benchmark**.

| Backend observation | Baseline | Local | Optional |
| --- | ---: | ---: | ---: |
| Median p95 | 2.640 ms | 2.660 ms | 2.615 ms |
| p95 change | — | +0.76% | -0.98% |
| Per-pass p95 range | 2.615–2.806 ms | 2.576–2.723 ms | 2.586–2.697 ms |
| Additional one-core CPU at 10 requests/s | — | -0.0004 percentage points | -0.0054 percentage points |
| Median sampled whole-process Go heap | 22,185,776 B | 21,770,584 B | 21,826,488 B |

Fixture-inclusive initialization live-heap increase: **890,664 B**, below 32 MiB.
All observed additional memory/CPU and the measured API p95 are within O01's
32 MiB / three core-percentage-point / 5% guardrails for this stated workload.
Latency remains a reported opt-in measurement, not a noisy shared-runner CI gate.

Electron diagnostic CPU/memory are measured separately with
`frontend/tests/diagnostics-budget.cjs`: three rotated rounds of isolated native
SQLite processes, 600 durable task edits at 60/s per mode, one explicit local
report/second, no/available/unavailable journal. Main heap+external allocations
are distinct from the full Electron renderer/SQLite RSS. All 600 intents must
remain queued in each case. The saved summary reports raw samples and medians.

| Native observation | No journal | Available journal | Unavailable journal |
| --- | ---: | ---: | ---: |
| Median durable-commit p95 | 5.954 ms | 5.833 ms | 5.961 ms |
| Per-round p95 range | 5.916–7.030 ms | 5.793–7.133 ms | 5.905–6.134 ms |
| Additional one-core CPU | — | +1.078 percentage points | +0.350 percentage points |
| Additional peak sampled main heap+external | — | 1,100,648 B | -307,200 B |
| Largest preview JSON | — | 16,103 B | 8,205 B |
| Journal bytes after 600 edits | 0 | 95,022 B | 0 |

All 5,400 fixture edits remained queued. Available/unavailable logging stayed
within the 16-MiB memory / three-core-percentage-point CPU guardrails. The median
native durable-commit p95 was -2.03% / +0.11%; filesystem scheduling dominates
per-round variability, so the negative result is not a performance claim.
The earlier exploratory 300-edit/three-preview-per-second experiment was noisy
and crossed 5% by 0.11 percentage points. The final reproducible experiment uses
600 edits per pass and the supported one-preview-per-second IPC cadence, with
rotated order and all raw observations retained; the threshold was not raised.
The batching contract separately verifies fewer file operations rather than
inferring a speedup solely from noisy before/after timing.

Log caps are enforced: native files 16 MiB total, seven-day retention at active
maintenance/startup, bounded 128-record pending/50-record fallback buffers,
100 exported records and 512-KiB report. A burst of 64 records now performs four
batched appends instead of 64; preview/shutdown flush pending records. Stopped
applications prune on next startup, not by a nonexistent background daemon.

Metrics saturation is **1,502 samples** for a known router and **1,637** with
intentional unknown-route overflow, below the example's 1,900 target sample cap
and 2,000-series design budget. Labels are bounded; no user/object IDs are labels.
Build info adds one series to the older O05 saturation evidence.

With both dashboards provisioned, the real optional fixture measured
**235,206,082 B** of combined container memory and **1,662,976 B** of monitoring
state; single CPU samples were 0.34%/0.93%. Prometheus/Grafana hard memory caps
remain 384/512 MiB (896 MiB combined), within the 1-GiB guardrail. An initial
256-MiB Grafana attempt hit OOM; unused plugins were disabled and the same total
budget rebalanced, rather than raising the agreed limit. The accelerated fixture
uses one-second scrape; the shipped example remains 30 seconds/seven days.

Persistent 512-MiB block retention is **not** a filesystem quota. Operators must
allocate/enforce a dedicated 2-GiB filesystem quota if a hard disk ceiling is
required; this repository does not claim that Compose/Prometheus can enforce it.
The short state measurement fits that allocation but does not prove a seven-day
peak. The isolated full-filesystem test confirms failure isolation, not guaranteed
ingestion: Prometheus may stay alive after ENOSPC while samples fail to persist.

## Reproduce without production data

From the repository root, using the existing local Docker context where needed:

```sh
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend run test:stories -- --project unit
node --test frontend/tests/*.test.cjs
PLAYWRIGHT_CHANNEL=chrome node frontend/tests/web-diagnostics.mjs
ELECTRON_EXECUTABLE=/absolute/path/to/electron node frontend/tests/native-diagnostics.mjs
node frontend/tests/diagnostics-budget.cjs
python3 -m unittest discover -s scripts/tests -v
python3 scripts/check-repository.py
```

In `backend/`, run `go test ./...`, the project's pinned `golangci-lint run ./...`
and, for the explicit timing workload only:

```sh
CLOCKWORK_DIAGNOSTICS_BUDGET=1 GIN_MODE=release GOMAXPROCS=2 \
  go test ./internal/server -run '^TestObservabilityBudget$' -count=1 -v
```

Use [optional monitoring](optional-monitoring.md) for its disposable Docker test,
[readiness](readiness.md) for its disposable PostgreSQL test and
[operator quickstart](diagnostics-quickstart.md) for actual troubleshooting.
No command here invokes a release/deployment workflow or changes a demo schedule.
