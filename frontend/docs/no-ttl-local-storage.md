# No-TTL local storage invariant

**Goal.** Cache and tokens are kept in non-volatile memory **without any
TTL**: nothing is deleted locally by age, timers or elapsed-time sweeps. Cache
of GET-responses and the mutation queue live in IndexedDB indefinitely; the
access token stays in process memory (AD-05, XSS protection) and the refresh
token lives in IndexedDB (`offline/session.ts`, all environments: web and
desktop share one profile) and is sent in the body of `/auth/refresh`; the
HttpOnly cookie is only a legacy fallback when no stored token exists. TTLs
are validated **only by the backend**.

> **Accepted tradeoff (documented 2026-09-10):** IndexedDB is readable by any
> script on the same origin, so an XSS reads the refresh token exactly like
> localStorage — this is a deliberate, documented compromise (see
> `services/frontend/.frontend-audit.md`, S-01). The real protection is
> server-side rotation plus reuse detection; the client-side model only keeps
> the short-lived access token out of persistent storage.

This document is the audit trail and the invariant to preserve. It is intended
for any agent working on `src/offline/*` so that changed cycle/connection logic
does not silently introduce age- or timer-driven cleanup.

## Invariant (final wording)

Local stores (`cache` / `outbox` / `idmap`) have **no TTL** and are **not
cleaned up by time**. Data is only every removed by:

1. explicit user actions — `clearOutbox()` (queue), `discardFailed()` /
   `discardEntry()` (rejected entries);
2. app-version change — `ensureCacheVersion()` clears **only** the cache
   (payload schema may differ between releases). This is version invalidation,
   **not** a TTL;
3. a verified online login — `pruneForeignOutbox()` deletes the queue entries
   created under the previous (now logged-out) account, whose session is revoked
   and which the flush-time creator guard would park forever. Logout itself does
   **not** wipe the queue: it is shared by every tab of the profile and a sibling
   tab of the same user may still have pending edits (H-OFF-3);
4. successful delivery / idempotent terminal states — a sent queue entry is
   deleted after its request succeeds. Its temp→real mapping remains available to
   later edits from other tabs until explicit queue clearing or account cleanup.

Server-side TTLs (refresh session 168h, access 15m) are validated **only** by
the backend.

## Audit of timer / time-based cleanup (`src/offline/*`)

Scope scanned: `setInterval` / `setTimeout` / `requestIdleCallback`,
`Date.now()` / `getTime()`, `idbClear` / `idbDel` / `localStorage.removeItem`
/ `.clear()`. Read-only files (cycle, sync, warmup, state) were inspected but
not modified.

Result: apart from the two explicitly-allowed exceptions below, **no local data
is deleted by time/age anywhere in the offline layer**.

- `warmup.ts` — `PULL_TTL_MS = 60_000` gates **freshness of a background PULL**
  (`cacheGetFresh` on `read`), it never deletes an entry. Re-fetch decision only.
- `cache.ts : ensureCacheVersion()` — full `'cache'` clear **only** when
  `__APP_VERSION__` changed. Version invalidation, retained invariant.

All other timer/`Date.now()` uses are **not** data cleanup:

- `warmup.ts` — `PAUSE_MS` pacing between pull steps; idle scheduling.
- `outbox.ts` — `PAUSE_MS` rate limit between sends; `FAILED_BACKOFF_MS`
  **retry backoff** and `MAX_FAILED_ATTEMPTS` → `quarantined` flag (entry is
  kept, just not auto-retried; user can `resetFailedRetries` / `discardFailed`);
  `ts` field is FIFO order, `failed.at` is bookkeeping. None deletes.
- `sync.ts` / `cycle.ts` — maintenance timers drive PULL/sync runs, timestamp
  localStorage keys (`mvs_erp_last_*`) are **UI timestamps only**.
- `state.ts` — `PROBE_TIMEOUT_MS` aborts a health probe request.
- `SyncToast.vue` — dismiss timer for the transient toast UI.
- `db.ts` / `cache.ts`/`outbox.ts` — `idbClear` / `idbDel` only from the
  explicit-user / version / post-delivery paths enumerated above.

## Guardrails for future changes

- Do **not** add age-based sweeps, expiry pruning or `setInterval` cleanup that
  deletes cache/outbox/idmap entries.
- `Date.now()` is allowed to *record* timestamps (`ts`) and to gate *re-fetch*
  freshness; it must never be the trigger for deleting stored data.
- Version invalidation of the GET cache (`ensureCacheVersion`) is fine; keep the
  mutation queue and idmap untouched there.
- Server holds the only truth about token/session TTL. The frontend must not
  drop its tokens by measuring elapsed time.

## Reusable cleanup module

`src/offline/outbox.ts` exports `clearOutbox`, `discardFailed`, `discardEntry`,
`resetFailedRetries` for targeted, user-initiated removals. The full local
reset (`clearLocalData`, `src/offline/reset.ts`) was removed along with its
"Clear local data" settings button; the mutation queue is now cleared only by
the targeted outbox functions or by the login/version paths enumerated above.
