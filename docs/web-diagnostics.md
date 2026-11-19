# Local web error diagnostics

[O08](http://localhost:3456/tasks/101) adds a small local reporter on top of the
[O02 diagnostic data contract](diagnostic-data.md). It requires no error service,
external SDK, telemetry endpoint, monitoring stack or browser offline engine.

## For users

Open **Diagnostics** from the application header or the sign-in screen. The panel
shows known frontend/backend versions, recent error categories, controlled error
codes and available server request IDs. Preview the report, then choose **Copy
report** if you want to share it with your administrator. Clipboard permission
failure leaves a selectable read-only report for manual copying. Nothing is sent
to the developers, an administrator or an external service automatically.

Opening the panel explicitly uses the existing public `/api/v1/about` read to
look up the backend version. That sends no report or history. The panel remains
usable if this read fails or the server is unreachable; an unknown version is
shown honestly. Successful About reads elsewhere also update the known version.
Closing the panel aborts its metadata request. Failed metadata reads cannot block
navigation or rendering.

**Clear history** removes only local diagnostic entries, not unsaved edits,
application data, authentication or queued Electron changes. Reloading the document
also discards this history. The panel is web-only; Electron's local journals and
support bundle belong to O09 and do not use this web history.

## Capture and meaning

The reporter observes Vue component errors, window script errors, unhandled
promise rejections, Vite preload/chunk failures, router errors, existing Axios API
failures and handled PDF/capture/printing failures. It does not patch `fetch`,
record every interaction, intercept network bodies for storage, measure all user
activity or create another command/synchronization queue. No background reporting
worker, persistence, interval, upload or new cross-tab channel is introduced.
Existing business reads/refresh and their error behavior stay independent.

| Category | Interpretation |
| --- | --- |
| Timeout | Axios timeout codes or the controlled `TimeoutError` discriminator |
| Network or browser restriction | Axios `ERR_NETWORK`; browser APIs do not reliably distinguish DNS, connection/TLS failure and CORS, so this is not a definitive CORS diagnosis |
| HTTP 401 | Authentication required; this can be a transient response before the existing refresh/retry succeeds, not necessarily a failed login |
| HTTP 403 | Request forbidden by the server; no role or object details are recorded |
| HTTP 409 | Server-reported conflict; not proof that an optimistic edit was accepted |
| HTTP 5xx | Server error; use its request ID for server-side investigation |
| Other HTTP error | Server rejected the request; only the numeric status and allowlisted code are retained |
| Vue/window/promise/navigation/chunk/PDF | Stage of the observed failure, without raw error text, source paths, component props, document content or stack |

Intentional request cancellation is ignored. The existing refresh, retry,
notification and offline/recovery flows are preserved. Passive window/Vite hooks
do not call `preventDefault`, reload the page or retry failed imports. Vue's
existing error handler is chained if present; otherwise it logs a safe record.
One failure may be observed at more than one stage (for example chunk loading and
navigation); stage groups are deliberately separate, not a count of unique bugs.

The reporter cannot recover an application that failed before its JavaScript
initialized, diagnose an unavailable VPS independently, or infer backend versions
when metadata is unavailable. It is a local support aid, not an availability SLA,
a replacement for server logs or proof of successful command delivery.

## Bounded data and session isolation

History is per document/tab and stays only in memory. It retains at most **50
records**, each at most **2 KiB** of serialized UTF-8 JSON. Equal stage/category/
code/status/version groups are deduplicated and moved to the front; a bounded
occurrence count and first/last observation time remain. A repeated API group
keeps the latest reviewed request ID rather than retaining every request.

Each event is reconstructed through `domain/diagnostics.ts`. Only closed
stage/category/event/error codes, bounded status/count/time, web platform, safe
version strings and a 32-character lowercase hexadecimal request ID enter the
report. Raw Axios configuration, request/response bodies, arbitrary headers,
messages, stacks, object names, FIO, usernames, actor/session IDs, URLs and query
strings never enter the history. The UI renders plain text, not HTML.

The existing session epoch is an in-memory scope discriminator, never an exported
field. History and backend version clear when that scope changes; identity changes
also invalidate pending diagnostics and close the panel. Cross-tab epoch events
reuse the existing session subscription. A pending response from the old context
cannot populate a new report, and a late clipboard/metadata completion cannot
show a success result in another session. Tabs keep separate histories; no
credentials, report or error objects are broadcast or persisted for diagnostics.
Records returned for copying are detached from the internal history.

There is no new third-party recipient, configurable export URL or automatic
opt-in transport. Source-map publication and CSP are unchanged; no inline script,
`eval`, blob-worker or extra `connect-src` permission is added for reporting.
Future O09 can reuse the same allowlisted diagnostic payload, with separate native
storage, rotation and export rules rather than sharing this web memory store.

## Validation

```sh
npm --prefix frontend run check
npm --prefix frontend run lint
npm --prefix frontend run test:stories -- --project unit
node frontend/tests/web-diagnostics.mjs
```

The browser acceptance suite starts its own loopback Vite server and a temporary
Chromium context, with intercepted fixture HTTP responses and the unchanged web
CSP. It needs installed dependencies and a local Chrome (`PLAYWRIGHT_CHANNEL` can
select another installed supported channel). It does not build a release, contact
a real backend, use existing browser profiles, credentials or application data.
It checks sign-in/manual report, actual Axios failures/correlation, promise/chunk
hooks, separate tab histories, navigation/Gantt/PDF capture/download/print (including Ctrl+S/Ctrl+P), handled
PDF failure/retry, offline/recovery, cross-tab epoch reset, a narrow-screen panel and
absence of diagnostic uploads/CSP violations. The intentional rejection in its
console is a fixture; any other runtime error fails acceptance.

Focused tests also exercise a real failing Vue render and lazy route, clipboard
failure, empty/overflow/deduplicated history, missing metadata, cancellation,
session changes during requests/copy and hook disposal. Existing PDF/print
stories and the complete application unit suite retain their own contracts.
