# Prepared demo alert rules (not activated)

This optional local evaluator consumes the safe JSON from
[host checks](demo-operations.md) and the [external probe](readiness.md).
It installs no timer, opens no port and sends no message. It is not required by
Clockwork or by other self-hosted installations. Ordinary Electron offline,
expected 403/409, no application traffic and optional exporter outages are not
server incidents in this mechanism.

The four fixed signals are external HTTPS/readiness, PostgreSQL health, selected
filesystem capacity/inodes and certificate expiry. Each uses consecutive samples
for both firing and recovery. Missing/stale/unknown observations become `no_data`,
not green. A failed HTTPS check suppresses a duplicate missing-TLS warning. There
is no duplicate deploy/audit/backup alarm: use those existing signals separately;
a backup age alarm needs a separately agreed backup schedule.

## Decisions before enabling

The owner must choose the external runner (outside the application VPS), sampling
interval, `debounce_samples`, `stale_after_seconds`, `tls_min_seconds`, disk policies
in the host checker, notification adapter, recipient and responder. Limits in the
example are deliberately null, and `enabled` is false. Enabling an incomplete
policy fails instead of silently inventing thresholds or a daily backup schedule.
There are no numeric SLOs or 24/7 response promises here.

```sh
python3 scripts/demo-alerts.py --config deploy/observability/alerts.example.json
```

After a separate approval, a private configuration can be evaluated with
`--host HOST_JSON --external PROBE_JSON --state PRIVATE_STATE_JSON`. The caller must
provide a private existing state directory. State replacement is atomic, mode
0600; one invocation owns an exclusive lock. A stale crash lock needs inspection
by the operator, never automatic removal of another process's lock. Input files
are bounded and must be regular, not symbolic links. Reports contain only fixed
signal/state codes and local transition IDs, without URL, recipients, errors,
secrets or body data.

The command outputs pending local events, **not delivered notifications**. Exit 0
means evaluation completed with no event due; it is not an overall "healthy"
statement. Exit 1 means events are pending; exit 2 means disabled/unknown/failure.
The prepared rules can be consumed by an existing independent owner monitor; no
Prometheus/Grafana subscription or new paid server is needed.

## Delivery contract and monitor failure

The library's `run_cycle(..., deliver=callback)` is the explicit adapter boundary.
Tests use an in-memory callback only. An owner-approved wrapper may route its
fixed events through one existing channel and persist the returned bounded state.
There is no built-in webhook/email/Telegram connection and no recipient secret in
Git. Choose and approve the real channel and its test separately.

A callback must return exactly `True` only after acceptance; exceptions/negative
results keep the same transition ID pending for retry. Do not acknowledge a print
to stdout as delivery. A recovered notification is sent only after a previous
nonhealthy state was accepted. Duplicate healthy samples do not repeatedly alert.
This is an at-least-once boundary: loss of an acknowledgement or a crash before
state persistence can duplicate a transition. The adapter/receiver can deduplicate
its stable ID; exactly-once delivery is not promised.

The owner runner must also notice a missing/late execution and a failing channel;
local application-VPS checks cannot detect their own host loss. Use the existing
runner's failure/heartbeat facility and a separately agreed responder, not an
additional mandatory monitoring server. Do not treat an absent JSON file, stale
probe timestamp, or failed delivery as recovery.

## Response notes

| Signal | First action |
| --- | --- |
| External readiness | Check independent DNS/HTTPS, then `/health` versus `/ready`; a ready-looking SPA is not API readiness. Inspect safe server request logs locally. |
| Database | Check storage, startup and PostgreSQL logs; preserve the volume. A running process is not proof of a ready schema. Never repair/migrate automatically to silence an alert. |
| Disk/inodes | Identify the configured mount, inspect backup/audit/log growth; preserve business data, backups and audit retention. Agree cleanup/capacity separately. |
| TLS | Check DNS, Caddy renewal, clock, ports and certificate/account volumes. Never bypass verification or delete certificate state. |
| No data/channel failure | Check the external runner, permissions, configured policies, file timestamps, clock and receiver; silence is not success. |

Local tests cover firing/resolved, debounce, deduplication, stale/missing input,
TLS/disk independence, client-error exclusion, channel outage/retry, disabled
policy, atomic private state and competing invocations. No actual delivery,
production configuration, schedule or demo threshold was set in this stage.
