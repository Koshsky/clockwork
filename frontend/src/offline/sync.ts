import { ref } from 'vue'
import { useAppStore, useAuthStore, usePlanningStore, useTimesheetStore, useRbacStore } from '@/store'
import { shouldAutoSync } from '@/settings'
import { isLoggedOut } from '@/loggedOut'
import { warmNow } from './warmup'
import {
  flushOutbox,
  pendingCount,
  refreshPendingCount,
  replayOutboxToCache,
  resetFailedRetries,
  type FailedSyncItem,
  type MutationEntity,
} from './outbox'
import { isOffline, probeBackend } from './state'

/**
 * Offline queue synchronization: when the network returns (and at app startup
 * with a saved queue) sends accumulated mutations to the backend, then
 * re-reads affected domains from the server — server truth wins,
 * and changes that could not be applied are visually rolled back.
 */

export interface SyncNoticeData {
  ok: number
  failed: number
  interrupted: boolean
  /** Unsent entries with reasons (for the toast) */
  failedEntries: FailedSyncItem[]
}

/** Result of the last sync (shown in the toast) */
export const syncNotice = ref<SyncNoticeData | null>(null)

export function dismissSyncNotice(): void {
  syncNotice.value = null
}

const LAST_PUSH_KEY = 'mvs_erp_last_push_at'

function readLastPush(): number | null {
  try {
    const raw = localStorage.getItem(LAST_PUSH_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Time of the last successful queue push (for UI; survives reloads) */
export const lastPushAt = ref<number | null>(readLastPush())

function noteLastPush(): void {
  lastPushAt.value = Date.now()
  try {
    localStorage.setItem(LAST_PUSH_KEY, String(lastPushAt.value))
  } catch {
    // the timestamp is not critical — it will update on the next run
  }
}

let syncFlight: Promise<void> | null = null

interface Reloader {
  name: string
  run: () => Promise<unknown>
}

function reload(name: string, run: () => Promise<unknown>): Reloader {
  return { name, run }
}

/**
 * Reload set per entity — the single source of truth for "which domains a
 * mutation invalidates". Used by BOTH consistency paths:
 *  - the offline queue flush (reconcile below),
 *  - the online post-mutation refresh (scheduleDomainRefresh): after an
 *    online success the same domains are re-read so related pages (the other
 *    Gantt aggregates) become server-fresh immediately instead of waiting for
 *    the slow PULL cycle.
 * Network refreshes only (refreshX): rendering is local-first, so reconcile
 * must NOT re-fetch via the local loaders.
 */
export function reloadDomainsFor(entity: MutationEntity): Reloader[] {
  const app = useAppStore()
  const planning = usePlanningStore()
  const ts = useTimesheetStore()
  const auth = useAuthStore()
  const rbac = useRbacStore()
  // Roster-family reloads (employees/states/periods) apply when the user can
  // see the roster. The RBAC matrix is authoritative; the preset is only a
  // cold-start fallback (mirrors useNavigation and warmup).
  const permsReady = rbac.permsLoaded || rbac.myPermissions.length > 0
  const seesRoster = permsReady
    ? rbac.can('worker', 'view')
    : auth.user?.preset === 'vp' || auth.user?.preset === 'admin'

  switch (entity) {
    case 'resource':
      return [reload('task-plan', () => planning.refreshTaskPlanning(true)), reload('resources', () => app.refreshResources()), reload('calendar', () => app.refreshCalendar())]
    case 'user':
      // A user CRUD (create/update/delete/manager change) alters the roster
      // (timesheet + employees page), the name catalog (/user/all) and the
      // assignee pool (/user?limit=500) — refresh all of them. The roster
      // reload stays gated by "sees the roster" (backend scoping).
      return [
        ...(seesRoster ? [reload('employees', () => ts.refreshEmployees(undefined, true))] : []),
        reload('users', () => app.refreshUsers()),
        reload('myStaff', () => app.refreshMyStaff()),
      ]
    case 'member':
      return seesRoster ? [reload('resources', () => app.refreshResources())] : []
    case 'state':
      return (permsReady ? rbac.can('state', 'view') : seesRoster) ? [reload('states', () => ts.refreshStates())] : []
    case 'period':
      return seesRoster
        ? [
            reload('calendar', () => app.refreshCalendar()),
            reload('employees', () => ts.refreshEmployees(undefined, true)),
            ...(ts.windowStart
              ? [reload('periods', () => ts.refreshPeriods(ts.windowStart, ts.windowEnd))]
              : []),
          ]
        : []
    case 'project':
      // Creating a project auto-creates processes/tasks/assignments server-side
      // (the template trigger); deleting cascades them away — every planning
      // aggregate that renders the project or its children must be re-read.
      return [
        reload('project-plan', () => planning.refreshProjectPlanning(true)),
        reload('projects', () => app.refreshProjects()),
        reload('process-plan', () => planning.refreshProcessPlanning(true)),
        reload('task-plan', () => planning.refreshTaskPlanning(true)),
      ]
    case 'process':
      // Deleting/editing a process changes the project's span and removes its
      // tasks — refresh the processes aggregate plus both neighbors.
      return [
        reload('process-plan', () => planning.refreshProcessPlanning(true)),
        reload('task-plan', () => planning.refreshTaskPlanning(true)),
        reload('project-plan', () => planning.refreshProjectPlanning(true)),
      ]
    case 'task':
    case 'milestone':
    case 'assignment':
      return [reload('task-plan', () => planning.refreshTaskPlanning(true))]
    case 'reorder':
      return [
        reload('project-plan', () => planning.refreshProjectPlanning(true)),
        reload('projects', () => app.refreshProjects()),
      ]
    default:
      return []
  }
}

const DOMAIN_REFRESH_DEBOUNCE_MS = 400

/** Pending domain names (reloader names) waiting for the coalesced flush */
const pendingDomains = new Set<string>()
let domainRefreshTimer: number | null = null
let refreshGeneration = 0
let refreshSuspended = false

function armDomainRefresh(): void {
  if (domainRefreshTimer != null) return
  domainRefreshTimer = window.setTimeout(() => void flushDomainRefresh(), DOMAIN_REFRESH_DEBOUNCE_MS)
}

/** Collects every domain reloader by name (rebuilt per flush — stores are cheap). */
function collectReloaders(): Map<string, () => Promise<unknown>> {
  const map = new Map<string, () => Promise<unknown>>()
  const entities: MutationEntity[] = [
    'resource',
    'user',
    'member',
    'state',
    'period',
    'project',
    'process',
    'task',
    'milestone',
    'assignment',
    'reorder',
  ]
  for (const e of entities) {
    for (const r of reloadDomainsFor(e)) {
      if (!map.has(r.name)) map.set(r.name, r.run)
    }
  }
  return map
}

/**
 * Coalesced background refresh of the named domains: a burst of mutations
 * (e.g. a dragged task bar cascading PUTs) collapses into ONE re-read per
 * domain. Silent (refreshX(true)) and error-tolerant — a refresh failure must
 * never fail the mutation that scheduled it. Skipped entirely while offline:
 * the outbox flush owns reconciliation there (reconcile).
 */
async function flushDomainRefresh(): Promise<void> {
  const own = refreshGeneration
  domainRefreshTimer = null
  const names = [...pendingDomains]
  pendingDomains.clear()
  if (names.length === 0 || isOffline.value) return
  const runs = collectReloaders()
  for (const name of names) {
    if (refreshSuspended || own !== refreshGeneration) break
    const run = runs.get(name)
    if (!run) continue
    try {
      await run()
    } catch {
      // silent — the next PULL cycle covers a failed domain
    }
  }
}

/**
 * Schedules the coalesced refresh of the domains a mutation invalidates
 * (online path — called after a successful apply in runMutation). No-op while
 * offline: queued mutations are reconciled by the outbox flush (reconcile).
 */
export function scheduleDomainRefresh(entities: MutationEntity[]): void {
  if (refreshSuspended || isOffline.value) return
  for (const e of entities) {
    for (const r of reloadDomainsFor(e)) pendingDomains.add(r.name)
  }
  armDomainRefresh()
}

/**
 * Schedules the coalesced refresh of named domains directly — the page-entry
 * SWR path: views render instantly from the cache (local-first) and then
 * re-read the domains they display while online.
 */
export function scheduleNamedRefresh(names: string[]): void {
  if (refreshSuspended || isOffline.value) return
  for (const n of names) pendingDomains.add(n)
  armDomainRefresh()
}

async function reconcile(entities: Set<MutationEntity>): Promise<void> {
  const runs = new Map<string, () => Promise<unknown>>()
  for (const entity of entities) {
    for (const r of reloadDomainsFor(entity)) {
      if (!runs.has(r.name)) runs.set(r.name, r.run)
    }
  }
  for (const run of runs.values()) {
    try {
      await run()
    } catch {
      // a single reload failed — data will be fetched on the next access
    }
  }
}

function runSync(): Promise<void> {
  if (syncFlight) return syncFlight
  syncFlight = flushAndReconcile().finally(() => { syncFlight = null })
  return syncFlight
}

async function flushAndReconcile(): Promise<void> {
  await refreshPendingCount()
  if (pendingCount.value > 0) {
    const auth = useAuthStore()
    // A late failure from startup must not overwrite the new reachability decision.
    await auth.waitForSessionRefresh()
    if (isLoggedOut() || !(await probeBackend())) {
      syncNotice.value = { ok: 0, failed: 0, interrupted: true, failedEntries: [] }
      return
    }
    // Explicit Push must recover even when automatic connection monitoring is disabled.
    isOffline.value = false
    if (auth.accessExpired()) await auth.refreshSession()
    if (isLoggedOut() || isOffline.value || auth.accessExpired()) {
      syncNotice.value = { ok: 0, failed: 0, interrupted: true, failedEntries: [] }
      return
    }
  }
  const res = await flushOutbox()
  if (res.ok > 0 || res.failed > 0 || res.interrupted) {
    if (res.ok > 0) noteLastPush()
    await reconcile(res.entities)
    syncNotice.value = {
      ok: res.ok,
      failed: res.failed,
      interrupted: res.interrupted,
      failedEntries: res.failedEntries,
    }
  }
}

/**
 * The "PUSH" button on the sync screen: queue flush + reconcile.
 * In-app synchronous calls (autosync) go through initOfflineSync.
 */
export function syncNow(): Promise<void> {
  return runSync()
}

/**
 * The "Sync all" button: PUSH (queue flush) then, if the network
 * is alive, PULL (offline cache warmup). Parts are independent: a failed one
 * does not break the other. Returns what actually ran (for the UI message).
 *
 * This is an explicit user action, so the PULL bypasses the per-domain TTL
 * (`warmNow(true)`) — "Обновить" must really refetch, unlike the automatic
 * warmups which skip domains that are still fresh.
 */
export async function syncAll(): Promise<{ pushed: boolean; pulled: boolean }> {
  try {
    await runSync()
    const n = syncNotice.value
    const pushed = n != null && (n.ok > 0 || n.failed > 0 || n.interrupted)
    let pulled = false
    if (!isOffline.value) {
      pulled = await warmNow(true)
    }
    return { pushed, pulled }
  } finally {
    // runSync/warmNow reset their own locks and progress
  }
}

/** The "Retry" button: lift quarantine and try sending again */
export async function retryFailed(): Promise<void> {
  await resetFailedRetries()
  await runSync()
}

/** The "Skip" button: removes rejected entries (see outbox) */
export { discardFailed } from './outbox'

/** Queue flushing & PULL are driven by the minute monitor (offline/connection.ts). */

/** Reconcile a saved startup queue; connection.ts owns recovery ordering */
export async function initOfflineSync(active = () => true): Promise<void> {
  // Write-through into the cache BEFORE the first data load (main.ts awaits this function):
  // an offline reload shows the unsynced queue changes.
  await replayOutboxToCache()
  if (!active()) return
  void refreshPendingCount()
  if (!isOffline.value) {
    void refreshPendingCount().then(() => {
      if (active() && shouldAutoSync() && !isLoggedOut() && pendingCount.value > 0) void runSync()
    })
  }
  // Periodic flushing & PULL are owned by offline/connection.ts (60 s loop).
}

/**
 * Unified session renewal used by 401 handling and the router guard — the
 * single path for ALL environments (web + desktop). The refresh token lives in
 * the non-volatile IndexedDB 'session' store and is sent in the body of
 * /auth/refresh (falling back to the HttpOnly cookie on the web when the store
 * is empty). Returns whether a fresh session is available.
 */
export async function ensureAutoSession(): Promise<boolean> {
  return useAuthStore().refreshSession()
}

/** Background session maintenance period (extending the access token silently) */
const SESSION_MAINTENANCE_MS = 30 * 1000

let maintenanceTimer: number | null = null

/**
 * Background session maintenance: every 30 s renew a session that is about to
 * expire (or already expired). The unified refresh path (ensureAutoSession)
 * picks the right source — the stored refresh token in all environments.
 * A fresh session and an unauthenticated visitor are left alone.
 */
export function startSessionMaintenance(): () => void {
  if (maintenanceTimer != null) return stopSessionMaintenance
  const auth = useAuthStore()
  auth.startBackgroundSession()
  maintenanceTimer = window.setInterval(() => {
    if (auth.isAuthenticated && auth.accessExpired()) void ensureAutoSession()
  }, SESSION_MAINTENANCE_MS)
  return stopSessionMaintenance
}

export function stopSessionMaintenance(): void {
  if (maintenanceTimer != null) window.clearInterval(maintenanceTimer)
  maintenanceTimer = null
  useAuthStore().stopBackgroundSession()
}

export function stopDomainRefresh(): void {
  refreshSuspended = true
  refreshGeneration++
  if (domainRefreshTimer != null) window.clearTimeout(domainRefreshTimer)
  domainRefreshTimer = null
  pendingDomains.clear()
}

export function resumeDomainRefresh(): void { refreshSuspended = false }
