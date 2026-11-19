# Local Electron diagnostics

Open **Diagnostics** on the sign-in page or in the application header. Preparing
and saving the report is local: it does not require a reachable backend, copy
SQLite, refresh credentials, upload telemetry or replay queued changes. Review the
read-only JSON preview, then choose **Save bundle** and a new destination through
the native file chooser. Saving writes exactly that preview; an existing file is
never overwritten. Refresh the report to capture subsequent changes.

## What is collected

The main process owns a separate `diagnostics/` directory inside the existing
Electron userData profile. Main, renderer, SQLite worker, synchronization and
command-delivery records use the same reviewed diagnostic projection as the web
client. Only fixed source/outcome/error codes, bounded durations, known versions,
HTTP statuses and validated request IDs survive. Raw errors, stacks, URLs, request
bodies, user/object names, account identifiers, vaults and database rows do not.

The report includes coarse OS/Node/Electron versions, known frontend/backend
versions (`unknown` until observed), storage phase, reachability/last pull and
read-only SQLite aggregates for the current account/server: pending, ready,
blocked, retry-waiting, unknown, conflict, rejected and retries. Queue age is wall
age, including offline and sleep. Active delivery duration starts at an actual
send/receipt lookup, excludes sleep and counts failed in-flight attempts. It is
not end-to-end server processing time or an availability SLO. Current-session
outcome counters reset with the session/process; SQLite remains authoritative.

## Bounds and failure behavior

- All account/server partitions share a **16 MiB** log budget, at most 128 files
  of at most 1 MiB and seven-day retention. Maintenance runs every minute while
  the app is open and at startup/write/report; a stopped application cannot
  delete expired files until its next launch. A private HMAC partition key keeps
  filenames from disclosing identities or server URLs; it is never exported.
- Pending writes are bounded at 128 records; the in-memory fallback keeps 50.
  The report reprojects at most 100 recent records, including stored records,
  so an edited log line cannot add arbitrary fields to an export.
- Reports are capped at **512 KiB**. Main keeps at most two preview snapshots,
  coalesces rapid refreshes and limits renderer error recording to eight/second
  per window. The IPC has the existing main-frame/origin checks, a 4 KiB request
  limit and current context/document checks. Renderers cannot choose file paths,
  submit file contents or query arbitrary database rows.
- A session/server change clears pending records, counters and preview handles;
  late responses and native chooser completions cannot export a previous context.
  Logs from the same account/server may be read after restart. They are private
  local diagnostics, not an audit trail or a durable business-command receipt.
- A full, read-only or unavailable diagnostic directory falls back to bounded
  memory and reports `unavailable`. Logs may be dropped. It never rejects a
  business acknowledgement, changes an intent or takes ownership of synchronization.
  A worker failure is recorded safely; the existing storage recovery flow is
  unchanged. An interrupted JSONL tail is ignored rather than exported raw.

Diagnostics do not include a second outbox, remote collector or automatic
support upload. Copying/sending a saved file to an administrator remains the
user's explicit choice. Do not attach entire profiles or database backups instead.

## Reproducing checks

From the repository root:

```sh
node --test frontend/tests/native-diagnostics*.test.cjs frontend/tests/desktop-command-queue.test.cjs
npm --prefix frontend run test:stories -- --project unit src/diagnostics/native.test.ts
ELECTRON_EXECUTABLE=/absolute/path/to/electron node frontend/tests/native-diagnostics.mjs
```

The last check uses actual Electron/preload/renderer with an isolated temporary
profile, local source-serving Vite and unchanged desktop CSP. It exercises two
windows, explicit preview/exact save and a server switch without an application
backend. Journal/storage tests cover restart, quota/retention, privacy, failed
storage, sleep and lost-response recovery; they do not package a desktop release.
This source UI check was run on macOS; it does not establish Windows/Linux GUI acceptance.
