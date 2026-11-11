# Two-tab session and offline regression

Run against the local Vite frontend and local backend with the current migrations:

```sh
set -a
source ../local/dev.env
set +a
export RBAC_TEST_ADMIN_PASSWORD="$ADMIN_PASSWORD"
npm run test:offline:multitab
```

Defaults: frontend `http://localhost:5173` (`ERP_TEST_URL`), API `http://127.0.0.1:8080/api/v1` (`RBAC_TEST_API_URL`), installed Chrome (`PLAYWRIGHT_CHANNEL`). Both endpoints must be loopback addresses. The local `JWT_SECRET_KEY` signs expired test access tokens; credentials and tokens are never printed.

The runner creates a disposable process-owner account, project and process, and removes them in `finally`. Both tabs use one isolated browser context, real shared IndexedDB and the real backend. The administrator fixture client is separate from the test account: revoking the test session does not revoke an administrator session. Autosync starts disabled to control fault timing; the reconnect case explicitly enables it and calls the connection monitor in both tabs.

| Case | Assertions |
| --- | --- |
| Concurrent expiry | Real menu clicks in both tabs complete; one shared refresh replaces correctly signed expired tokens without logout. |
| Simultaneous offline creation | Both tabs create tasks during the same frozen millisecond; temporary IDs differ, a dependent edit targets its own task, and both tabs see the same three queued operations. |
| Offline navigation and reload | Warmed routes remain navigable with browser networking disabled; with only the API unreachable, reload preserves authentication, queue identities, original idempotency keys and visible edits. |
| Committed response lost | The backend commits a creation, but delivery and subsequent health probes fail; one server record exists while the complete original queue remains durable. |
| Concurrent reconnect | Both connection monitors restore connectivity and flush; the lost response is retried using the original key and a server replay, the dependent edit reaches the correct task, and both tabs see an empty queue. |
| Refresh revoked by backend | A real logout revokes the test refresh session; expired access leads to login, keeps the queue unchanged in both tabs, and same-user login resumes it without duplication or quarantine. |
| Suspended refresh owner | Hold the atomic refresh lock in one tab and reload the other. Its cached navigation and task data render within four seconds before the lock is released; renewal finishes afterwards. |
| Empty cache and durable queue | Keep a real backend-rejected edit in quarantine and a new unsent task, clear only the disposable browser cache, and reload. Successful planning responses render through the queue overlay; server tasks and the unsent task appear together while both original queue entries remain unchanged. |
| Slow shared renewal | Hold the refresh response beyond two seconds while the other tab sends a queued write; it cannot report authorization success with an expired token. Cached menu navigation completes within 1.5 seconds while the response is held. Releasing it completes the mutation exactly once. |

Browser runtime errors fail the runner. Fresh backend reads verify final task identities and titles. At-least-once delivery is allowed: correctness means one committed result per original idempotency key, not one transport attempt.

Unit tests cover atomic refresh ownership and lock release, abandoned leases, missing Web Locks, waiting without false success, expired broadcasts, connectivity/logout changes during renewal, durable 401 interruption for create/update/delete, and safe temporary-ID boundaries.

The test uses full browser offline mode only for previously loaded routes. Reloads keep the frontend shell available and interrupt the API transport. It does not assert cold startup without network or installation of a service worker.


## Stale logged-out profile regression

Run `npm run test:session:stale` against the same local stack. It reproduces a cached profile with the shared logout flag, no bearer token and an empty cache, while retaining one offline task creation. Real 401 responses must open login without refreshing or bouncing back to planning. A second tab with a still-valid in-memory token must also respect the logout flag. A verified same-account login restores server data, preserves the queued task through reload, flushes it once and restores the sibling tab. Unit tests also reject late refresh responses after logout and ensure the shared refresh token and logout marker are committed before publishing manual-login authentication.


## Browser-free concurrency regression checks

Run `npm run test:stories -- --project unit` and `npm run test:session:locks:http`.
The latter requires Node.js with native Web Locks (verified with Node.js 26.13.0) and the local API; credentials
are read from `../local/dev.env` or `RBAC_TEST_ADMIN_PASSWORD`. It uses isolated
worker contexts, never a browser profile, and does not log out or revoke the
user's existing sessions. It verifies nonblocking lock contention, owner
termination, successive real refresh requests and planning reads.

Unit coverage includes idle IndexedDB connection release, overlapping transactions,
old-handle close events, frozen refresh owners, malformed legacy leases, rejected
and delayed token broadcasts, local storage and temporary HTTP failures, logout
during rotation, competing queue senders, late edits referencing completed offline
creates and preservation of visible pending work when storage is temporarily unavailable.

Queue sending uses nonblocking Web Locks on supported secure origins (HTTPS or
localhost). A busy sender is retried by the next minute cycle; it never blocks
navigation. Legacy environments without Web Locks retain the existing per-tab
queue guard and server idempotency protection, not atomic cross-tab ownership.
Refresh coordination similarly retains its legacy storage-lease fallback there.

Only the refresh owner writes the rotated token to the shared IndexedDB store.
Broadcast receivers adopt the access token without replaying old refresh writes.
A successful server rotation whose new token cannot be persisted requires a new
login: reusing its revoked predecessor would invalidate other sessions.
