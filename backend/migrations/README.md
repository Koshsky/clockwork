# Database migrations

Core SQL (`V1__*.sql` through `V12__*.sql`) is embedded by `go:embed` into
`cmd/service`. The image needs no SQL mount, Flyway installation, Java, or
network access to fetch migrations. Existing files and their Flyway checksums
are immutable. Add a new sequential core file for every schema change.
The source adapter exposes the original files to golang-migrate as upward-only
migrations; SQL execution, PostgreSQL locking and dirty/version bookkeeping are
provided by `github.com/golang-migrate/migrate/v4` (pgx/v5 driver).

## Lifecycle

- A fresh database: startup applies V1 through the latest embedded core version.
- A Flyway database without a native version: startup refuses to run until an
  administrator executes `service migrate adopt-flyway` once.
- Adoption validates successful history entries, known core filenames and
  Flyway 9 CRC32 checksums. Core versions must form a contiguous prefix.
  Unknown successful SQL plugins, dotted versions and historical repeatables
  are preserved without requiring their original files. Unsupported history
  types, failed records, gaps and checksum mismatches block adoption.
- The baseline is the last contiguous **core** version, never the largest
  Flyway version: V1–V9 plus V1020 becomes native version 9, not 1020.
- Adoption uses golang-migrate's `Force` only after those checks. It executes no
  migration SQL and never writes to `flyway_schema_history`.
- `service migrate up` or application startup applies later core migrations.
  Native `schema_migrations` contains one `(version, dirty)` row; it is not a
  per-file audit log. Flyway history remains an archived audit trail.
- Repeating adoption at an equal or later clean native version is a no-op.
  A dirty/conflicting/ahead native state is rejected; adoption never rewinds it.
- A SQL failure leaves a dirty native version and prevents application startup.
  Investigate and restore/repair deliberately; never blindly clear the flag.

Adoption acquires Flyway 9's PostgreSQL advisory lock. Normal migrations use
**golang-migrate's different advisory lock**. Stop all external Flyway jobs and
application replicas before handover. The two engines must never run together.

Only core root SQL is embedded. Deployment seeds, credentials and plugin SQL
are excluded from the image and are never automatically replayed. After
handover, package future plugin schema changes as reviewed sequential native
migrations; old Flyway plugin numbers do not enter the native version namespace.
Do not re-enable Flyway after native migrations have run: its archived history
will not record those changes, so it could replay SQL.

## Commands

Only `DATABASE_URL` is required for these commands; they do not initialize HTTP,
Redis, tracing, JWT or administrator bootstrapping:

```sh
./service migrate status
./service migrate adopt-flyway --dry-run
./service migrate adopt-flyway
./service migrate up
```

`status` and `--dry-run` create no tables or history records. Adoption itself
records a baseline but does not apply V10. `up` reports version 13/dirty false
after a successful upgrade. An already-applied V10 is adopted as 10 and skipped.

V11 enforces matching process/resource owners for assignments and removes
assignments when either owner changes. V12 converts process/task `self` or
legacy `own` permission tokens to `up1` for every action, in both preset and
individual rules. Denials remain denied; resource/project rules are unchanged.
Existing deployments receive these changes through new files, never edited
historical migrations or a replay of Flyway plugins.

Migration SQL has a five-minute statement limit and lock waits have a 15-second
limit. Cancellation stops adoption immediately and asks golang-migrate to stop
between migrations; an in-flight native SQL operation is bounded by the SQL
statement timeout rather than immediate context cancellation. There is no
automatic downgrade or automatic dirty-state repair command.

## Local rehearsal

```sh
bash scripts/test-migration-upgrade.sh
```

Requires Docker, Go and the cached/downloadable `postgres:16-alpine` and
`flyway/flyway:9.20.0` images. The script creates and removes its own database
container/network, uses synthetic identities, and retains logs in ignored
`build/migration-test.*`. It tests real Flyway V1–V9 plus unknown plugins and an
already-applied V10 separately, as well as fresh startup, checksum/gap/failed
history rejection, dirty SQL failure, concurrent startup and repeat adoption.

See [the administration runbook](../docs/operations/migration-upgrade.md).

### V13: predefined role matrix

V13 replaces grants for existing `dp`, `rp`, `vp`, and `worker` tags. Custom presets, renamed/deleted tags and personal overrides survive. Legacy custom project-update grants and personal project-update grants/revokes are copied to the new project-only `prioritize` capability. DP reads all planning and changes only priorities; RP manages owned projects and their contents; VP manages owned processes and resources; worker has no preset rights. Take a database backup before upgrading.
