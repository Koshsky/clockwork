# Offline P0 integration tests

Run against the local Vite frontend and local dev backend, with the current migrations installed. The Vite API proxy must target the local backend (`VITE_API_PROXY_TARGET=http://127.0.0.1:8080`). The test accepts only loopback frontend URLs.

```sh
npm run test:offline:p0
```

Defaults:

- Frontend: `http://127.0.0.1:5173` (`ERP_TEST_URL`).
- Browser: installed Google Chrome (`PLAYWRIGHT_CHANNEL`).
- Login: `admin`, with `ADMIN_PASSWORD` read from `../local/dev.env`; override with `ERP_TEST_PASSWORD` or `ERP_TEST_ENV`.

The test uses a separate browser context with real IndexedDB and disabled automatic sync so fault injection controls each flush. It creates an isolated project, process and resource; its tasks belong to that project. The `finally` block deletes those fixtures and clears only the test browser's queue. No existing business objects are edited.

| Case | Fault and assertions |
| --- | --- |
| P0-1 | Abort API transport during creation; verify optimistic cache and queue survive a document reload, then sync exactly one task. |
| P0-2 | Forward creation to the real backend, receive its successful committed response, abort delivery to the browser; verify the stored original key is replayed, `Idempotency-Replayed: true` is returned, and exactly one task exists. |
| P0-3 | Drop the second write and subsequent health probe during a flush; verify only the acknowledged prefix is removed and the remaining suffix survives reload and is sent later. |
| P0-4 | Queue create, edit and resource assignment with a temporary task id; verify FIFO order, a positive final id, one assignment and its quantity. |
| P0-5 | Queue an update to a missing task and an independent valid update; verify rejection reason/quarantine, no automatic retry of the rejected entry, and successful independent work. |
| P0-6 | Accept the creator, then let the real backend commit a dependent edit while holding its response; reload the document mid-flush. Verify the unsent suffix, original keys and persistent id map survive; retry the edit via server replay and finish its resource assignment without duplication. |

Successful cases compare the planning store, persistent GET cache, outbox and fresh server data. Case P0-5 intentionally retains the rejected entry until explicit cleanup: quarantine requires a user decision rather than an infinite retry loop.

Transport failures are injected at the API boundary; the frontend shell remains reachable for document reloads. This verifies backend disconnection and offline data behavior, not offline installation or service-worker caching of application assets. Responses and persistence come from the real local backend, except for the deliberately aborted/held transport.

The unit regressions additionally cover exact id rewriting (including query parameters), preservation of user text/dates and FIFO timestamps when multiple enqueues occur in one millisecond.
