# Optional private Prometheus/Grafana example

The standard application Compose/deployment never includes this example. Use an
existing private scraper if available; there is no requirement to run another
stack, buy a server or deploy this to the public demo. Existing audit Loki and its
volumes/retention are not a data source here and are not changed.

## Topology and explicit setup

The standalone `deploy/observability/compose.yml` has only an explicit `monitoring`
profile. It joins the network namespace of an **already running, explicitly
selected backend container**. Prometheus scrapes its loopback `127.0.0.1:9091`,
listens only on loopback `9090`, and Grafana connects to that same private Prometheus.
No Docker socket, privileged container, host namespace or public port is used.
Grafana listens on an owner-selected private address in that backend namespace,
port 3001. It has no application credentials, business database or audit access.

Enabling is a separate operator action, not something these files perform:

1. Enable [O05 metrics](metrics.md) explicitly on `127.0.0.1:9091` in the backend
   configuration and restart it by the installation's approved procedure.
2. Choose the actual backend container and its current private interface address.
   Set `CLOCKWORK_BACKEND_CONTAINER` and `CLOCKWORK_GRAFANA_BIND` accordingly.
   Do not use a public/wildcard address. Loopback works only for clients already
   inside that namespace (including the isolated test), not a host SSH forward.
3. Create a strong password file outside Git in a private mode-0700 directory.
   With local Compose file secrets, make the file readable by the container's
   Grafana UID (472). A mode-0444 file **inside the private parent** is one option;
   Docker mounts just that file, read-only, without exposing its parent. Never
   put it in the public repository or a world-accessible directory.
   Set `CLOCKWORK_GRAFANA_PASSWORD_FILE` to its absolute path. The first-start
   admin login is `owner`; changing this file does not rotate an existing admin
   password in persisted Grafana state. Use Grafana's password management instead.
4. Validate the model without displaying secret values or starting services:

   ```sh
   python3 scripts/check-monitoring.py
   ```

5. If separately approved, start only this optional project:

   ```sh
   docker compose -f deploy/observability/compose.yml --profile monitoring up -d
   ```

6. Reach the private Grafana address through an existing trusted route or SSH
   forward, for example `ssh -N -L 3001:PRIVATE_BACKEND_IP:3001 operator@host`.
   Open `http://127.0.0.1:3001`. Do not publish Grafana or Prometheus on the public
   gateway. There is no anonymous login, signup, public snapshot publishing,
   plugin installation UI, automatic plugin preinstall, update checking or
   analytics reporting in the supplied configuration.

Non-Prometheus datasource plugins are disabled, both Go runtimes have a 320-MiB
soft memory target and one worker CPU; cgroups remain the hard process limits.
The initial 256-MiB Grafana experiment failed startup; the supplied allocation
was rebalanced within the original 1-GiB total budget, not raised beyond it.

The application container has no dependency on these services. If it is recreated,
its old namespace is not automatically replaced in the monitoring containers:
recreate only the optional stack against the current backend ID/address afterwards,
preserving its own named volumes. A stop/restart of the monitoring containers
retains their own TSDB and Grafana state. Never use application volume names or
`down -v` on the application project to reset monitoring. Runtime acceptance
removes only UUID-owned test volumes; it does not run these commands on a server.

## Pinned tools and resource budget

The example pins Prometheus 3.16.0 and Grafana 13.3.1 with their verified registry
manifest digests. The configuration was checked with the actual pinned promtool
and actual containers, not just YAML parsing. Consult the upstream
[Prometheus storage guide](https://prometheus.io/docs/prometheus/latest/storage/),
[command flags](https://prometheus.io/docs/prometheus/latest/command-line/prometheus/)
and [Grafana Docker configuration](https://grafana.com/docs/grafana/latest/setup-grafana/configure-docker/)
when reviewing upgrades; do not silently replace the digest with latest.

| Scope | Supplied setting / initial acceptance budget |
| --- | --- |
| Process memory | Prometheus 384 MiB + Grafana 512 MiB cgroup limits = 896 MiB, below 1 GiB total |
| CPU ceiling | 0.25 core each; this is a ceiling, not a measured idle CPU claim |
| Scrape | 30s, 3s timeout; only the Clockwork target, no self/fleet scraping |
| Cardinality | 1,900 target samples maximum plus bounded automatic scrape samples; label/body limits; no entity/user/operation IDs |
| Retained TSDB blocks | 512 MB and up to 7 days; the earlier retention condition wins |
| WAL segments | 16 MB; WAL/head/replay/compaction consume additional disk |
| Queries | At most 2 concurrent queries, 200,000 query samples |
| Optional Docker logs | 2 × 2 MB per container, separate from business audit |
| Temporary files | 16 MiB tmpfs per monitoring container |

Initial total disk budget is **2 GiB**, including state, WAL/head/compaction,
Grafana SQLite, container logs, tmpfs and reserve. A planning allocation is 512 MiB
blocks, 896 MiB WAL/head/compaction, 128 MiB Grafana, 8 MiB logs, 32 MiB tmpfs and
472 MiB reserve. These are allocation targets, not independent filesystem quotas.
Retention size controls blocks, **not** a hard bound on all TSDB bytes, and
seven-day retention is not a hard age/byte guarantee during compaction or failure.

For a hard installation limit, provision a dedicated filesystem/quota for the two
optional data volumes (for example at most 1.8 GiB state, leaving the rest for logs,
tmpfs and reserve). Docker's default local-volume driver does not enforce this
quota for the operator. The validator checks isolation/memory/auth/ports, not the
host's filesystem quota; it must not be used to claim a hard disk reservation.
Track actual free space and reject an unsuitable host/workload rather than
silently increasing this budget. High series churn and manual Grafana writes can
consume extra disk even with a small active-series limit.

A full/unwritable optional data filesystem can stop its collector/dashboard or
lose monitoring samples. It must not change application readiness, commands,
Loki retention or business volumes. There is no automatic application cleanup,
TSDB repair, deletion of backups or silent fallback to unbounded state. Inspect
and resolve optional storage independently. No-data is not zero failures or zero
latency. A cold target needs two samples before a rate can be calculated.

## Existing integrations instead of this stack

An existing private Prometheus can scrape O05 directly with the supplied scrape
limits; use an explicitly bound private address and a firewall/tunnel. Private
addressing is not authentication or encryption. Keep remote access under the
operator's trusted network boundary. Do not add a public `/metrics` proxy or use
a user's JWT as a scraper credential.

Existing log tools can consume the local JSON logs; existing OTLP receivers can
use [O04's explicit TLS/auth exporter](tracing.md). No Alloy, technical Loki,
Tempo/Jaeger, remote-write, HA, object storage or external client-report intake is
bundled or enabled here. Logs/request IDs remain useful without Grafana.

## Isolated verification

Fast policy tests: `python3 -m unittest discover -s scripts/tests -p test_monitoring.py -v`.
Opt-in runtime test uses cached pinned images and cached `node:22-alpine` for a
synthetic private exporter/namespace fixture, no application credentials or data:

```sh
DOCKER_CONTEXT=colima CLOCKWORK_MONITORING_DOCKER_TESTS=1 \
CLOCKWORK_MONITORING_TEST_DIR=/absolute/private/docker-shared/test-directory \
  python3 -m unittest discover -s scripts/tests -p test_monitoring_docker.py -v
```

On Linux use the existing local Docker context and a private temporary directory.
The fixture accelerates scrape/evaluation to 1s/500ms only in a temporary copy,
leaving the actual example at 30s/3s. It verifies scrape/no-data, authentication,
no published ports, memory/disk observations, container restart persistence and a
real full 64-KiB tmpfs failure isolated from the backend fixture. UUID containers,
volumes and secret/config files are removed afterwards. This is a bounded test
workload, not a production seven-day capacity claim or a recommendation to
activate this profile on erp.koshsky.ru.

## Recorded local result (2026-11-19)

On local Colima Linux/aarch64, the accelerated one-second synthetic target used
231,829,667 bytes of container memory combined, 1,617,920 bytes of persistent
monitoring state, and a single stats sample of 0.45%/0.66% CPU (Prometheus/Grafana).
Both process memory limits still total 896 MiB; observations are not reservations
or a seven-day/peak-workload result. Auth, scrape/no-data, restart persistence,
no published ports and an actual ENOSPC on an isolated 64-KiB TSDB filesystem passed.
Prometheus can remain alive during storage trouble; process liveness alone must
not be treated as proof of successful ingestion. The application fixture stayed
running throughout. Every fixture container and volume was removed.
