# Resource planning regression checks

Run unit, type and lint checks:

```sh
npx vitest run --project unit
npm run check
npm run lint
```

Run the browser integration matrix with an installed Google Chrome:

```sh
PLAYWRIGHT_CHANNEL=chrome npx vitest run --project storybook src/components/planner/TaskPlanning/ResourceRecalculation.stories.ts
```

Without `PLAYWRIGHT_CHANNEL`, Vitest uses its default Playwright Chromium installation.

The Days and Weeks stories exercise the real timeline, task bars, resource header and Pinia actions. Pointer events drive the actual drag listeners; Axios adapters simulate delayed acceptance, canonical dates and rejection without contacting a live backend. Each story covers:

1. Assigning a resource: immediate load preview, accepted assignment id, rejected-request rollback.
2. Removing an assignment: immediate load reduction, accepted deletion, rejected-request rollback.
3. Held task moves in both directions, including reversal and cancellation: live resource preview with no mutation request.
4. Released moves: one request, optimistic pending state, canonical accepted dates and immediate rollback after rejection even if reconciliation fails.
5. Both resize handles: expanding and shrinking, held previews, release and API acceptance/rejection.
6. Twelve assigned resources: every resource row recalculates, while unrelated task load remains included.
7. Day and ISO-week units: weekly peak daily load and minimum availability, including a peak and a minimum occurring after Monday.
8. Adding an employee absence: immediate period and availability preview, accepted save and rejected rollback; adjacent dates/weeks and unrelated resources remain unchanged.
9. Deleting an absence: immediate restored availability, accepted deletion and rejected rollback.

Store unit tests also cover partial dependency-cascade acceptance, HTTP-success error envelopes, an older rejected task edit following a newer accepted edit, partial absence deletion, absence replacement, available states and stale reads started before an edit.


## Minute autosync and offline recovery

The connection monitor runs automatic PUSH then cache PULL every 60 seconds. Health probes remain separate at 10 seconds and do not load application data. Hidden tabs, disabled autosync and logged-out sessions do not run automatic work. Reconnection triggers queue-first recovery immediately. Failed cycles retain the queue for retry.

An active mutation invalidates reads begun before or during it. Such reads cannot replace planning state or overwrite the saved GET cache. Warmup defers while mutations are active or queued (including quarantined edits); a subsequent post-mutation refresh or minute cycle catches up. Offline mutations keep the existing IndexedDB write-through overlay.

`connection.test.ts` advances fake time to check minute boundaries, non-overlapping cycles, offline suspension and queue-before-cache recovery. `warmup.test.ts`, `mutationGuard.test.ts`, `http.test.ts` and the planning store tests cover stale-read suppression, cache fallback and queued edits. Both resource integration stories additionally use real IndexedDB to queue an offline task move, reconstruct planning from the cache, reject a stale server read and flush the saved edit before reconciliation GETs. API and health responses are simulated.
