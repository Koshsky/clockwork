# Optional demo operations checks

[O07](http://localhost:3456/tasks/100) prepares lightweight local observations for
our demo. It does not install a monitoring platform, enable a timer, change the
server, schedule backups, send notifications or delete anything. Other self-hosted
installations can keep their existing tools and omit this script entirely.

## Execution and configuration

`scripts/check-demo.py` uses Python 3.11+ standard libraries and the local Docker
CLI. Run it natively on the Linux Docker host, with read access to its deployment
state and selected filesystems. Docker access is privileged: use an existing
trusted operator context, not a network-facing collector, HTTP handler, application
container or mounted Docker socket in a monitoring container. No database account,
SQL query, password, bootstrap login or application token is needed. App version
reads use only the existing unauthenticated loopback About endpoint and the
frontend build manifest inside the already identified containers. No build,
image pull, service restart, stack reconciliation or backup/restore is performed.

The repository example is **disabled** and all policy limits are unset:

```sh
python3 scripts/check-demo.py --config deploy/observability/demo-check.example.json
```

This returns `not_configured`, exit 2, without Docker or network calls. After a
separate decision to enable these checks, copy the example to a private file
outside Git on the host, retain restrictive permissions, then explicitly set
`enabled: true`. Use absolute paths and verify the local Docker context and Compose
project/container names. It is not necessary to install anything now.

Before scheduling, the owner must choose the interval, limits, notification
channel and responder. No interval or backup frequency is assumed here. The
existing deployment preflight's free-space reserve is not a new monitoring policy.
O12 owns notifications; O13 owns independent external HTTPS/readiness checks.

Configuration:

| Field | Meaning |
| --- | --- |
| `root` | Existing deployment root, normally `/opt/erp`; reads `.clockwork/requests` and `.clockwork/backups` |
| `project`, `containers` | Expected Compose project and explicit local container names; mismatched labels become unknown |
| `disks` | Logical labels `application`, `docker`, `database`, `audit`, `backups` mapped to existing host paths |
| `tls` | `null` (no connection) or `{"host":"erp.koshsky.ru","port":443}`; certificate verification stays enabled |
| `limits` | Nonnegative byte/count/second values, or `null` to observe without a health judgement |

The example deliberately omits Docker/DB/audit mountpoints: discover them locally
rather than assuming they share `/opt/erp`'s filesystem. `docker info --format
'{{.DockerRootDir}}'` and targeted `docker volume inspect --format
'{{.Mountpoint}}' VOLUME_NAME` help the operator map the existing mounts. Existing
volume names are recorded in [deployment](deployment.md). Paths stay in the private
configuration, not the report. The same filesystem may appear under several
logical labels; do not sum those capacities. This checks filesystem capacity, not
per-directory usage. Observe audit/backup growth by tracking available bytes over
time; no recursive `du`, backup reads or retention changes occur in ordinary polls.

Limits use the `min_`/`max_` direction expressed in their names; equality is
acceptable. Disk and inode limits apply to each configured filesystem. A missing
path or Linux `MemAvailable` value is unknown, not zero and not healthy. Configure
all relevant mounts before using this for demo coverage. Missing policy produces
`observed`; missing configuration produces `not_configured`.

## Interpretation and privacy

Output is one JSON object containing logical check names, fixed statuses,
resource counts/ages, actual image IDs, sanitized canonical version tags and UTC
observation/restore times. It contains no raw inspect JSON, container environments,
healthcheck logs, mount paths, deployment errors, request payloads, table contents,
certificate subjects, DSNs or credentials. Treat the remaining topology/version
metadata as internal; the script neither listens nor sends the report anywhere.
Unrecognized/malformed state and failed commands become `unknown`. `failed` means
an observed failure or an explicit policy violation. No data is a distinct state.

Exit codes: **0** all reported statuses `ok`; **1** an observed failure/incomplete
backup; **2** incomplete knowledge, unset policy, recorded evidence without current
verification, or work in progress. Missing version tags, optional checks or routine
unhashed restore evidence can therefore keep exit 2 even while services are healthy.
Consumers should use individual JSON fields; do not turn every exit 2 into a paging
incident. A failed checker invocation is also not evidence of a healthy host.

| Observation | Meaning and limitation |
| --- | --- |
| Memory | Linux `MemAvailable`, not `MemFree`; host RAM only, not a container quota |
| Disk/inodes | `statvfs` available blocks/inodes for the caller; reserved blocks do not count as available; unsupported inode reporting is unknown |
| Services | Project/service labels, running flag, restart count, existing health status and immutable image ID; no full inspect/environment/health-log read |
| DB | Existing Docker healthcheck (`pg_isready`) says PostgreSQL accepts connections; it does not validate schema, application credentials or migrations |
| Versions | Running backend About response and frontend `build-target.json`; only the canonical version is retained. Also local canonical `koshsky/erp-{backend,frontend}:vX.Y.Z` tags attached to that exact image ID, when present; moving aliases are ignored |
| TLS | Verified certificate expiry from a TLS handshake; bounded connect/socket timeout, OS DNS resolution follows host resolver behavior; no HTTP/login probe |
| Deploy | Latest request's existing sanitized `status.json` phase; failed, in-progress, succeeded and stale in-progress differ; no payload/env reads |
| Backups | Latest attempt and last completed deploy backup are separate; incomplete attempts cannot erase evidence of an older completed dump |
| Restore | Last valid operator restore attestation and its own date/age, possibly for an older dump; never inferred from dump presence or deploy success |

Docker CLI calls have a five-second timeout and selected output is capped at
128 KiB before parsing; JSON/state files are also size-limited. Inventories are
limited to 1,000 entries per directory; overflow is unknown and needs operator
attention, never automatic deletion. Checks execute once and independently. On a
host with many backup records, metadata scanning still has a cost; choose an
interval after measuring it. Routine polling does **not** hash or open dump bodies.

A digest-pulled image may have no local version tag; that reports unknown version
metadata while retaining its actual image ID. The tag is an image alias, not a
claim about the running binary's self-reported version. Compare IDs with the
successful deployment's pinned digests, and use the existing About UI for
application-reported versions. The `release` observation reads that backend
metadata and the frontend build manifest from the exact inspected container ID;
failures remain unknown rather than falling back to aliases. Never infer a release from `latest` or `stable`.
An application container's existing `/health` remains liveness. O13 supplies the
separate application/schema readiness contract. A checker on this VPS alone cannot
detect VPS loss; independent external checking is deliberately separate.

## Backup and restore evidence

The existing deployer creates a custom-format `database.dump`, runs
`pg_restore --list`, writes ancillary archives and finally writes the `complete`
marker. `catalog_check: verified_at_creation` only recognizes that existing marker:
it records the deploy-time catalog check, **not** a present checksum verification
or a successful restore. Dump age is its filesystem modification age; clock/file
metadata and these local receipts are trusted operator evidence, not signed proof.
The script does not validate ancillary archives or copy them off the host.

After an actual isolated restore **and application/data checks**, the operator may
write `restore-test.json` next to that specific dump. Do not create it after just
`pg_restore --list`. Example schema (replace the digest and UTC timestamp with
values from the completed test):

```json
{
  "schema": 1,
  "dump_sha256": "<64 lowercase SHA-256 hex characters of the tested dump>",
  "restored_at": "2026-11-19T12:00:00.000000Z",
  "result": "restored_and_checked"
}
```

Obtain the digest with a streaming SHA-256 calculation on that tested dump, and
record a timezone-aware UTC completion timestamp after the checks. Keep the
receipt and dump protected from untrusted writers. The routine report calls this
`recorded` with `digest_checked: false` (or `failed` when its agreed age limit
is exceeded); it trusts the operator's statement and
does not claim to have performed a restore itself.

For a manual comparison with the current dump bytes:

```sh
python3 scripts/check-demo.py --config /private/path/demo-check.json --verify-restore-evidence
```

This streams at most one attested dump through SHA-256, rejects mismatches,
concurrent size/mtime changes and invalid/future timestamps, and includes
`evidence: operator_attested_restore`. It is **not** a restore command. A 30-second
elapsed hashing budget is checked between chunks; timeout is unknown, not success.
Do not schedule this potentially expensive operation as a frequent poll. A newly
completed backup without a restore test does not replace the separate older
restore-test date. Neither this script nor the deployer claims that a newer,
untested dump has been restored.

## Short response guide

| Signal | First response |
| --- | --- |
| Low disk/inodes | Confirm the affected logical mount. Inspect Docker logs, PostgreSQL, audit Loki and backup growth locally. Preserve data; do not automatically prune volumes, remove backups or change retention. Agree capacity/retention work separately. |
| Low available RAM | Inspect the local process/container usage and OOM/restarts. Check workload changes before increasing limits or adding monitoring processes. |
| DB not healthy | Read the DB's local logs and check storage/startup. Do not run migrations or recreate the DB volume to silence the signal. Unknown/missing health is different from a measured SQL fault. |
| Failed/stalled deploy | Inspect the existing private request status and Actions run locally. Compare running image IDs and pinned deployment images; use the existing recovery procedure, not a blind retry. |
| Missing/old/incomplete backup | Inspect the last deploy backup attempt and available space. Age requires an agreed backup schedule; deploy-only backups are not daily backups. Preserve the last complete set. |
| Missing/stale/invalid restore evidence | Plan an isolated restore and data checks. Preserve dump/receipt; do not produce a success receipt to clear a warning. |
| Expiring/unverifiable TLS | Check Caddy issuance/renewal, DNS, clock and ports. Preserve Caddy certificate/account volumes; never bypass TLS verification. |
| Unknown/checker stale | Check local permissions, directory bounds, host clock, Docker context and invocation status. No checker output must not be interpreted as zero failures. |

This stage leaves existing external volumes, Docker network, Caddy's reserved IP,
container recreation order, Loki retention, backups and credentials unchanged.
No production schedule, thresholds or notification destination has been selected.

## Local verification

Fast behavioral checks:

```sh
python3 -m unittest discover -s scripts/tests -p test_demo.py -v
```

Optional runtime acceptance, using only a cached `postgres:16-alpine` image:

```sh
DOCKER_CONTEXT=colima CLOCKWORK_DEMO_DOCKER_TESTS=1 \
  python3 -m unittest discover -s scripts/tests -p test_demo.py -v
```

On Linux use the existing local Docker context instead of Colima. The test creates
one UUID container with tmpfs PostgreSQL data, no published port, no host binds,
no existing volumes and no network. It creates fixture rows, makes a real custom
dump, verifies its catalog, restores and compares fixture data, then checks that
the collector distinguishes healthy/stopped DB and attested restore. Only that
fixture is removed. Failure/low-space/privacy cases use deterministic local
fixtures; no production endpoint, backup or credentials are accessed.
