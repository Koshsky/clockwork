# Local operation and audit-delivery diagnostics

These diagnostics work without Prometheus, OTLP, a collector or a new database.
Existing application logging remains the primary operator interface. Published
migrations, API responses/headers, RBAC checks, transactions, replay and revision
rules are unchanged. No diagnostic failure deletes a business command or receipt.
No client/device registry or automatic support upload is introduced.

## Operation observations

The existing server-owned request/trace context accompanies controlled `stage`
and `outcome` fields on `diagnostic outcome` records. The vocabulary is closed:
HTTP headers, operation IDs, body hashes, user/entity IDs, SQL, error messages and
business payloads cannot become these fields. The central logger retains only
controlled error codes. Request IDs correlate an observation with its HTTP summary.

| Boundary | Observations |
| --- | --- |
| `durable` / `legacy` | `accepted` after an acknowledged commit; `replayed` for a saved reply; `in_progress`, `conflict`, `rejected`, `failed` or `unknown` otherwise |
| `receipt` | `confirmed`, `in_progress`, `not_found`; invalid/unauthorized lookups are `rejected`, unavailable lookup/storage is `unknown` |
| `revision` | `rejected` invalid input, `conflict` stale baseline after the original RBAC decision, `unknown` on unavailable revision storage |
| `rollback` | `rolled_back` when rollback returned success, `unknown` on a real rollback error; already closed transactions and repeated successful cleanup are not new rollback outcomes |
| `migration` / `rbac` | `ready` after successful schema validation/policy publication, `failed` otherwise |
| `planning` / `calendar` | Read failures classified as `failed`, `rejected`, `conflict` or `canceled`; original errors, scope and query ordering remain intact |

`accepted` means that this server observed a successful transaction commit. It
is not proof that the client received the response. If the response disappears
after commit, the original receipt remains authoritative. A receipt confirmation
and a replay never count as another accepted commit. A failed/ambiguous commit
keeps the existing `unknown` protocol behavior; diagnostics do not guess that it
succeeded. A later confirmed rollback is a separate fact, not an invented success.
A denied request must not reveal whether its revision baseline was stale.

These are process-local observations, not a global durable ledger. Legacy keys
keep their original TTL semantics: re-execution after expiry can be a new commit.
Successful RBAC reloads are load observations, not user mutations. HTTP attempts
are still counted separately from commits. After a process restart, aggregate
counts reset while durable operation receipts remain in PostgreSQL. A historical
receipt/replay can therefore exist when the new process has zero accepted commits.
Client recovery must keep using receipts, not diagnostic counters.

## Audit delivery status

The existing two 1024-event buffers, critical-event priority, three asynchronous
attempts/backoff and one bounded synchronous attempt remain. `audit.sync: true`
is **best effort**: failure is logged/ignored by Enqueue, so it is not a durable
transactional audit/outbox. This implementation does not change that contract.

`Sender.Status()` / `Middleware.Status()` return an in-process, identity-free
`diagnostics.AuditStatus`. The snapshot contains `enabled`, `sync`, `stopped` and
two named queues (`regular`, `critical`). Each queue exposes:

- `pending`, `in_flight`, `oldest_age_ms`: current backlog, active deliveries and
  local age of the oldest event not yet started. Empty queues have age zero.
  Payload timestamps cannot control this age. Metadata is bounded by the buffer capacities plus the single worker handoff.
- `enqueued`, `delivered`, `attempts`, `retries`: accepted events, acknowledged
  send successes, transport attempts and additional asynchronous attempts.
- `overflow`, `exhausted`, `inline_failures`, `after_stop`: rejected enqueues,
  exhausted asynchronous retries, failed single synchronous sends and rejected
  enqueues after asynchronous shutdown began.
- `last_shutdown_pending`: queued plus in-flight work observed when the last
  Stop caller's context expired. This is a snapshot, not a cumulative loss count.

A retry increments attempts/retries without inventing another enqueued/delivered
event. `delivered` records a successful client Send return; it does not establish
exactly-once storage in Loki. An unavailable response may hide an already accepted
push. `Dropped()` preserves its old meaning: queue overflow only, not every failure.

Errors, retry exhaustion and shutdown backlog have safe local log records.
Queue-error logs include the queue name, pending/in-flight counts and oldest age;
DEBUG additionally shows enqueue/retry snapshots. No periodic status worker,
extra network call or metrics scraper is needed for these logs. Buffer contents,
actor details, event paths and Loki response bodies are not technical diagnostics.

Stop remains a bounded wait for the existing best-effort drain; pending work can
continue after its caller's deadline. Its counter must not be described as already
lost or delivered. Repeated Stop calls do not panic or recount deliveries. Enqueue
and shutdown synchronize their acceptance boundary so a late event is visibly
rejected rather than silently accepted after the worker exits. Synchronous Stop
retains its existing no-op behavior.

In-memory counters cannot report events lost in an abrupt kill, OOM, host failure
or crash. Overflow confirms that the sender rejected an event; exhausted/inline
failure means delivery was not confirmed. Reliable audit persistence would need
a separately agreed transactional outbox/storage design.

The safe snapshot is an internal diagnostic contract for composition/support
adapters, not a new public HTTP endpoint. O09 owns Electron queue/report data.
No actor identity, device/account inventory or remote session lookup is added here.

## Optional metrics

The private O05 endpoint reads these same aggregates; it performs no SQL/Loki call:

- `clockwork_outcomes_total{stage,outcome}`: observed, process-local outcomes;
  absent combinations are not fabricated as business successes.
- `clockwork_audit_{pending,in_flight,oldest_age_seconds}{queue}` and flags
  `clockwork_audit_{enabled,sync,stopped}`: current safe sender status.
- `clockwork_audit_{enqueued,delivered,attempts,retries,overflow,exhausted,inline_failures,after_stop}_total{queue}`.
- `clockwork_audit_last_shutdown_pending{queue}`: the latest timeout snapshot.

There are at most 108 authored stage/outcome pairs and two audit queue labels.
The combined HTTP/runtime/pool/outcome/audit saturation test measured 1636 series,
below the example's 2000-series budget. Optional metrics can be disabled without
removing local counts, delivery status or logs. Neither logs nor metrics are used
to authorize a request, decide a transaction outcome or discard queued commands.

## Verification and limits

Normal Go tests cover concurrent counters/redaction, legacy commit/replay/error,
queue priority/overflow/age, retry exhaustion, inline failure, real slow/unavailable
loopback Loki, repeated/deadline shutdown, middleware correlation, planning/
calendar errors and preservation of the last published RBAC snapshot. Race tests
cover the new state and existing transaction/middleware contracts.

The integration-tag suite additionally uses a disposable local PostgreSQL/API
for lost responses, receipts, safe retry after commit failure, RBAC/revision
conflicts and rollback. Actual write/read phases around an API process restart
verify that receipts survive reset counters. Migration checks use a separate
disposable database. These tests do not use production credentials, personal seed
data or the deployed server. Containers/databases are removed after verification.
No public diagnostics API, persistent audit guarantee, notification, release,
image publication or deployment is part of this stage.
