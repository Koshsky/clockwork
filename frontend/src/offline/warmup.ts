import { applicationServices } from '@/store/data/applicationClients'
import { ref } from 'vue'
import { nativeSync, queueRequest } from './desktopQueue'
import { hasActiveMutations } from './mutationGuard'
import { pendingCount, pendingRefs } from './outbox'
import { useAppStore, useAuthStore, usePlanningStore, useRbacStore, useTimesheetStore } from '@/store'
import { isOffline } from './state'
import { cacheGetFresh } from './cache'
import { apiPath } from './hydrate'
import { platformCapabilities } from '@/platform/context'
import { warmupEnabled } from '@/settings'

/**
 * Background PULL: refreshes the offline data cache from the backend.
 *
 * Rendering is local-first (hydrateFromCache) — pages NEVER fetch. The ONLY
 * network GETs belong here (plus auth/health/probe):
 *  - full warmup: after login / re-login, on network return, manual "Обновить";
 *  - the minute maintenance cycle (offline/connection.ts) refreshes only domains
 *    whose cached copy is older than its TTL — no constant unnecessary GETs.
 *
 * Requests run sequentially at WARMUP_RATE_PER_SECOND (10/sec); a repeated
 * start is ignored while the previous one is still running.
 */

const WARMUP_RATE_PER_SECOND = 10
/** Pause between warmup steps (1000 ms / 10 = 100 ms) */
const PAUSE_MS = 1000 / WARMUP_RATE_PER_SECOND
const IDLE_TIMEOUT_MS = 2000

/** Default per-domain staleness: a cached copy younger than TTL is not re-fetched */
export const PULL_TTL_MS = 60 * 1000

let running = false
let scheduled = false
let suspended = false
let generation = 0
let cancelScheduled: (() => void) | null = null
const cancelPauses = new Set<() => void>()

const LAST_WARMED_KEY = 'mvs_erp_last_warmed_at'

function readLastWarmed(): number | null {
  try {
    const raw = localStorage.getItem(LAST_WARMED_KEY)
    const n = raw ? Number(raw) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/** Time of the last warmup run (for the profile UI; survives reloads) */
export const lastWarmedAt = ref<number | null>(readLastWarmed())

/** Warmup progress 0..100, null — no warmup running (for the UI indicator) */
export const warmupProgress = ref<number | null>(null)

export interface PullStep {
  name: string
  /** Cache endpoint used for the TTL staleness check */
  path: string
  /** Optional key filter for endpoints shared by several queries */
  keyPredicate?: (key: string) => boolean
  /** The network refresh (owns the GET) */
  refresh: () => Promise<unknown>
  /** Staleness limit; the step is skipped while the cache copy is younger */
  ttl?: number
  /** If true — never pulled by the minute cycle (heavy/logical), full warmup only */
  cycle?: boolean
}

function runWhenIdle(fn: () => void): () => void {
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (typeof w.requestIdleCallback === 'function') {
    const id = w.requestIdleCallback(fn, { timeout: IDLE_TIMEOUT_MS })
    return () => w.cancelIdleCallback?.(id)
  } else {
    const id = window.setTimeout(fn, IDLE_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }
}

function pause(): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timer)
      cancelPauses.delete(finish)
      resolve()
    }
    const timer = window.setTimeout(finish, PAUSE_MS)
    cancelPauses.add(finish)
  })
}

/**
 * PULL steps per the user's RBAC matrix (heavy requests at the end of the
 * queue). Preset strings are only a cold-start fallback before /permissions/me
 * arrives — a custom preset or a server-side matrix grant must not silently
 * starve the user of data (mirrors useNavigation's permsReady logic).
 */
export function buildPullSteps(): PullStep[] {
  const auth = useAuthStore()
  const app = useAppStore()
  const planning = usePlanningStore()
  const ts = useTimesheetStore()
  const rbac = useRbacStore()

  const preset = auth.user?.preset ?? ''
  const userId = auth.user?.id

  // The matrix is authoritative once loaded; the preset is only a fallback.
  const permsReady = rbac.permsLoaded || rbac.myPermissions.length > 0
  const canView = (resource: string, roles: string[]): boolean =>
    permsReady ? rbac.can(resource, 'view') : roles.includes(preset)

  // Which data domains the user actually reads, per the matrix:
  const timesheet = canView('worker', ['vp', 'admin']) // employees / periods
  const dayTypes = canView('state', ['vp', 'admin'])
  const resourceList = canView('resource', ['vp', 'admin']) || canView('task', ['dp', 'rp', 'admin', 'vp'])
  const planningData =
    canView('task', ['dp', 'rp', 'admin', 'vp']) ||
    canView('process', ['dp', 'rp', 'admin']) ||
    canView('project', ['dp', 'rp', 'admin'])
  const projects = canView('project', ['dp', 'rp', 'admin'])

  const steps: PullStep[] = [
    {
      name: 'permissions',
      path: apiPath('/permissions/me'),
      refresh: () => rbac.refreshPermissions(),
    },
    ...(userId != null
      ? [
          {
            name: 'profile',
            path: apiPath(`/user/${userId}`),
            refresh: () => auth.fetchProfile(userId),
          },
        ]
      : []),
  ]
  if (projects) {
    // Keep this path identical to the generated client endpoint (projectGet →
    // `/project`, singular); the cache key must match store hydration
    // (loadProjects) so offline reads and the PULL freshness gate find the
    // same keys. Re-check both after regenerating src/api.
    steps.push({ name: 'projects', path: apiPath('/project'), refresh: () => app.refreshProjects(true) })
  }
  if (resourceList || planningData) {
    steps.push({ name: 'users', path: apiPath('/user/all'), refresh: () => app.refreshUsers() })
  }
  if (resourceList) {
    steps.push({
      name: 'resources',
      path: apiPath('/resources'),
      // Silent: a background pull must not flip the Resources page's loading
      // flag (the "Загрузка…" line would flash over a full table every cycle).
      refresh: () => app.refreshResources(true),
    })
    // Resource members (/resources/{id}/members): consumed by the "Employees"
    // resource badges and the "Resources" expandable rows. They are read
    // local-first (cache hydrate); without a PULL step the cache stays empty
    // and every badge disappears. Fetched only on full warmup — one request
    // per resource (heavy when many).
    steps.push({
      name: 'members',
      path: apiPath('/resources'),
      keyPredicate: (key) => /\/resources\/\d+\/members/.test(key),
      refresh: async () => {
        if (!app.resources.length) await app.refreshResources(true)
        for (const r of app.resources) {
          if (r.id != null) await app.refreshResourceMembers(r.id)
        }
      },
      cycle: false,
    })
    // Assignments reference (fallback in removeResource)
    steps.push({
      name: 'assignments',
      path: apiPath('/assignment'),
      refresh: () => applicationServices.assignments.list(500, undefined, 0),
    })
  }
  if (planningData) {
    // Task "assignee" candidate pool (own employees): the SPA editor reads it
    // from the cache under /user?limit=500 — without this pull the select is
    // always empty (local-first rendering never issues its own GETs).
    steps.push({
      name: 'myStaff',
      path: apiPath('/user'),
      keyPredicate: (key) => /\blimit=500\b/.test(key),
      refresh: () => app.refreshMyStaff(),
    })
    steps.push({
      name: 'project-plan',
      path: apiPath('/planning/projects'),
      refresh: () => planning.refreshProjectPlanning(true),
    })
    steps.push({
      name: 'process-plan',
      path: apiPath('/planning/processes'),
      refresh: () => planning.refreshProcessPlanning(true),
    })
    steps.push({
      name: 'task-plan',
      path: apiPath('/planning/tasks'),
      refresh: () => planning.refreshTaskPlanning(true),
    })
  }
  if (dayTypes) {
    steps.push({
      name: 'states',
      path: apiPath('/timesheet/states'),
      refresh: () => ts.refreshStates(),
    })
  }
  if (timesheet) {
    steps.push({
      name: 'employees',
      path: apiPath('/user'),
      keyPredicate: (key) => /\blimit=50\b/.test(key),
      refresh: () => ts.refreshEmployees(undefined, true),
    })
    // Timesheet periods: the batch endpoint (/user/days) is a single request
    // (chunked at BATCH_IDS_MAX), so the step participates in the 60-second
    // cycle like the planning diagrams — the staleness gate uses its cache copy
    // (written by http.ts on the same pathname): repeat pulls skip it while the
    // copy is still fresh, so the user sees current ranges without needing a
    // mutation first (previously cycle:false left periods stale until an edit).
    steps.push({
      name: 'periods',
      path: apiPath('/user/days'),
      refresh: () =>
        ts.windowStart
          ? ts.refreshPeriods(ts.windowStart, ts.windowEnd)
          : Promise.resolve(),
    })
  }
  if (planningData || timesheet) {
    // Availability calendar (540 days) — the heaviest, warmed last
    steps.push({ name: 'calendar', path: apiPath('/timesheet/calendar'), refresh: () => app.refreshCalendar() })
  }
  // Skip domains the user turned off on the "Какие данные прогревать" screen.
  return steps.filter((s) => warmupEnabled[s.name] !== false)
}

/** Whether the cached copy of `step` is still fresh (younger than its TTL). */
async function isStepFresh(step: PullStep): Promise<boolean> {
  // A pathname can belong to several owners, windows and pagination queries.
  // Web entry reads have exact query caching; the minute refresh is explicit.
  if (platformCapabilities.kind === 'web') return false
  const ttl = step.ttl ?? PULL_TTL_MS
  if (!step.path) return false
  const entry = await cacheGetFresh<unknown>(step.path, step.keyPredicate)
  return entry != null && Date.now() - entry.ts < ttl
}

/**
 * Runs the pull steps sequentially with a rate pause. `cycle` mode skips heavy
 * steps flagged cycle:false and refreshes only stale domains. Stops on offline
 * or logout (otherwise every 401 would trigger session refresh attempts).
 *
 * The TTL staleness gate applies in BOTH modes. It used to be cycle-only, so a
 * repeat full warmup (e.g. scheduled by a silent session rotation) re-fetched
 * every domain even though the cached copies were seconds old — on the "Табель"
 * page that reloaded the roster and all employee periods on every trigger and
 * made the grid re-render/flicker. `refreshAll` (the explicit "Обновить" /
 * manual warm) is the only caller allowed to bypass the gate.
 */
async function runPull(settings: { cycle: boolean; refreshAll?: boolean; generation: number }): Promise<number> {
  const steps = buildPullSteps()
  const targets = settings.cycle ? steps.filter((s) => s.cycle !== false) : steps
  const total = targets.length
  let done = 0
  let refreshed = 0
  warmupProgress.value = total > 0 ? 0 : null
  for (const step of targets) {
    if (suspended || settings.generation !== generation || isOffline.value || !useAuthStore().isAuthenticated || hasActiveMutations() || pendingCount.value > 0 || pendingRefs.value.size > 0) break
    // Fresh cached copies are left alone in every mode, unless an explicit
    // full refresh was requested.
    if (!settings.refreshAll && (await isStepFresh(step))) {
      done++
      continue
    }
    if (suspended || settings.generation !== generation || isOffline.value || hasActiveMutations() || pendingCount.value > 0 || pendingRefs.value.size > 0) break
    try {
      await step.refresh()
      refreshed++
    } catch {
      // a single request failed — don't abort the whole warmup
    }
    if (suspended || settings.generation !== generation) break
    done++
    warmupProgress.value = total > 0 ? Math.round((done / total) * 100) : null
    if (isOffline.value) break
    await pause()
  }
  // i18n-allow: developer console diagnostics, never rendered in the UI
  console.log(`[warmup] warmed requests: ${done} (refreshed: ${refreshed})`)
  return refreshed
}

/**
 * Full (TTL-aware) warmup — the "Warm data"/"Обновить" path. Returns true if
 * actually started. Runs in every environment.
 *
 * `force` bypasses the per-domain TTL (explicit user action); the automatic
 * callers (login, reconnect) leave it false so repeat triggers are cheap.
 */
export function warmNow(force = false): Promise<boolean> {
  if (nativeSync) return queueRequest<{ lastPullAt: number | null; reachable: boolean | null; code?: string }>({ action: 'sync', force, pullOnly: true }).then(state => state.lastPullAt != null && state.reachable !== false && !state.code)
  if (suspended || running || isOffline.value) return Promise.resolve(false)
  running = true
  const own = generation
  return runPull({ cycle: false, refreshAll: force, generation: own })
    .then(() => {
      if (suspended || own !== generation) return false
      lastWarmedAt.value = Date.now()
      try {
        localStorage.setItem(LAST_WARMED_KEY, String(lastWarmedAt.value))
      } catch {
        // the timestamp is not critical — it will update on the next run
      }
      return true
    })
    .finally(() => {
      if (own === generation) { running = false; warmupProgress.value = null }
    })
}

/**
 * The minute cycle PULL: refreshes only stale domains (younger copies are
 * left alone — no constant unnecessary GETs). Returns the number of domains
 * refreshed (0 — everything was already fresh).
 */
export function pullStaleCycle(): Promise<number> {
  if (nativeSync) return queueRequest({ action: 'sync', force: false, pullOnly: true }).then(() => 0)
  if (suspended || running) return Promise.resolve(0)
  running = true
  const own = generation
  return runPull({ cycle: true, generation: own })
    .then((refreshed) => {
      if (suspended || own !== generation) return 0
      if (refreshed > 0) {
        lastWarmedAt.value = Date.now()
        try {
          localStorage.setItem(LAST_WARMED_KEY, String(lastWarmedAt.value))
        } catch {
          // ignore
        }
      }
      return refreshed
    })
    .finally(() => {
      if (own === generation) { running = false; warmupProgress.value = null }
    })
}

/** Schedules full warmup when idle. Idempotent (one run at a time). */
export function scheduleWarmup(): void {
  if (nativeSync) return
  if (suspended || running || scheduled) return
  if (isOffline.value) return
  if (!useAuthStore().isAuthenticated) return
  scheduled = true
  const own = generation
  cancelScheduled = runWhenIdle(() => {
    if (suspended || own !== generation) return
    cancelScheduled = null
    scheduled = false
    void warmNow()
  })
}

export function stopWarmup(): void {
  suspended = true
  generation++
  cancelScheduled?.()
  cancelScheduled = null
  for (const cancel of [...cancelPauses]) cancel()
  scheduled = false
  running = false
  warmupProgress.value = null
}

export function resumeWarmup(): void { suspended = false }
