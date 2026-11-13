import { watch, getCurrentScope, onScopeDispose } from 'vue'
import { isOffline, probeBackend, reconnectDeadline } from './state'
import { syncNow } from './sync'
import { pullStaleCycle, scheduleWarmup } from './warmup'
import { pendingCount, refreshPendingCount } from './outbox'
import { shouldAutoSync } from '@/settings'
import { isLoggedOut } from '@/loggedOut'
import { hasActiveMutations } from './mutationGuard'

/**
 * Legacy desktop connection & maintenance monitor. Its platform runtime owns
 * startup and cleanup; starting it twice is a no-op.
 *
 * It watches backend reachability and drives autosync:
 *   - ONLINE: probes /health every ONLINE_PROBE_MS (10 s, see below); while the
 *     connection
 *     is healthy it auto-pushes the mutation queue once a minute (
 *     only when there are pending entries) then refreshes stale cache domains in the same cycle.
 *   - OFFLINE (a probe fails): flips isOffline and starts a reconnect countdown
 *     (reconnectDeadline, set to now + 60 s on going offline); on the deadline
 *     it probes again;
 *     success returns online and immediately flushes the queue + warms up.
 *   - The window `online`/`offline` events switch state immediately, without
 *     waiting for the next timed probe.
 *
 * The monitor never polls a hidden tab and stops all scheduled work when
 * autosync is off or the user has explicitly logged out (same guards as the
 * old cycle.ts it replaces).
 */

// Heartbeat probe while the connection is up. 2 s was excessive constant noise
// (30 requests/minute just to learn "still online"), so it is raised to 10 s:
// the hidden-tab guard (canWork) and the event-based online/offline handlers
// below still react to a real network change immediately, and the heartbeat
// only has to notice a silently dropped connection.
const ONLINE_PROBE_MS = 10000
const PULL_STALE_MS = 60 * 1000 // slow PULL refresher (stale cache domains only)
const OFFLINE_RETRY_MS = 60 // reconnect attempt interval (seconds)
const COUNTDOWN_TICK_MS = 1000 // one countdown step per second

/** Guards against double-starting the monitor (idempotent) */
let started = false
let generation = 0
let stopOfflineWatch: (() => void) | null = null

/** Guards against overlapping auto-push/recovery while a flush is in flight */
let pushing = false
let recovering = false
/** Guards against overlapping probes (a probe can take up to PROBE_TIMEOUT_MS) */
let probing = false

/**
 * Background PULL freshness marker (survives reloads via localStorage).
 * Re-exported here so imports from the deprecated './cycle' still resolve (cycle.ts).
 */
export { lastPullAt } from './freshness'
import { notePull } from './freshness'

/** Whether scheduled work may run right now (visible tab + user not signed out) */
function canWork(): boolean {
  if (document.hidden) return false
  if (!shouldAutoSync() || isLoggedOut()) return false
  return true
}

let heartbeatTimer: number | null = null
let pullTimer: number | null = null
let countdownTimer: number | null = null

function stopOnlineLoop(): void {
  if (heartbeatTimer != null) window.clearInterval(heartbeatTimer)
  if (pullTimer != null) window.clearInterval(pullTimer)
  heartbeatTimer = null
  pullTimer = null
}

function stopCountdown(): void {
  if (countdownTimer != null) window.clearInterval(countdownTimer)
  countdownTimer = null
}

function startOnlineLoop(): void {
  if (!started) return
  stopOnlineLoop()
  heartbeatTimer = window.setInterval(() => void onlineHeartbeat(), ONLINE_PROBE_MS)
  pullTimer = window.setInterval(() => void minuteSync(), PULL_STALE_MS)
}

function startCountdown(): void {
  if (!started) return
  stopCountdown()
  countdownTimer = window.setInterval(() => countdownTick(), COUNTDOWN_TICK_MS)
}

/** Schedules the next automatic reconnect attempt 60 s from now. */
function scheduleReconnect(): void {
  reconnectDeadline.value = Date.now() + OFFLINE_RETRY_MS * 1000
}

/** The connection dropped: flip offline and begin the reconnect countdown. */
function gotoOffline(): void {
  if (isOffline.value && countdownTimer != null) return
  stopOnlineLoop()
  isOffline.value = true
  scheduleReconnect()
  startCountdown()
}

/** Backend confirmed reachable: go online, flush the queue and warm up. */
async function handleBackendUp(): Promise<void> {
  const own = generation
  if (!isOffline.value) return
  if (recovering) return
  recovering = true
  try {
    stopCountdown()
    isOffline.value = false
    reconnectDeadline.value = null
    startOnlineLoop()
    if (canWork()) {
      await refreshPendingCount()
      if (!started || own !== generation) return
      if (pendingCount.value > 0) await syncNow()
      if (started && own === generation && !isOffline.value) scheduleWarmup()
    }
  } catch {
    // Preserve the queue; a later cycle can retry without an unhandled rejection.
  } finally {
    recovering = false
  }
}

/** A single online heartbeat probe → offline when it fails. */
async function onlineHeartbeat(): Promise<void> {
  if (!started || probing || !canWork()) return
  const own = generation
  probing = true
  try {
    const alive = await probeBackend()
    if (started && own === generation && !alive) gotoOffline()
  } finally {
    probing = false
  }
}

/** Flush queued edits before the minute cycle reads server snapshots. */
async function autoPush(): Promise<void> {
  if (pushing || isOffline.value || !canWork()) return
  if (pendingCount.value <= 0) return
  pushing = true
  try {
    await syncNow() // runSync flushes the outbox + reconciles + raises the notice
    await refreshPendingCount()
  } finally {
    pushing = false
  }
}

/** Slow PULL of expired cache domains (keeps the cache fresh when online). */
let minuteRunning = false
async function minuteSync(): Promise<void> {
  if (!started || minuteRunning || recovering || hasActiveMutations() || isOffline.value || !canWork()) return
  minuteRunning = true
  const own = generation
  try {
    await autoPush()
    if (!started || own !== generation || isOffline.value || !canWork()) return
    const refreshed = await pullStaleCycle()
    if (started && own === generation && refreshed > 0) notePull()
  } catch {
    // A failed push must not start a pull over unsent changes.
  } finally {
    minuteRunning = false
  }
}

/** One reconnect-countdown tick: probe once the deadline has passed. The
 *  deadline is wall-clock time, so the attempt happens after 60 s regardless
 *  of browser timer throttling on hidden tabs. */
function countdownTick(): void {
  if (!canWork() || reconnectDeadline.value == null) return
  if (Date.now() >= reconnectDeadline.value) {
    void retryConnectionNow()
  }
}

async function pingBackend(): Promise<void> {
  if (probing) return
  const own = generation
  probing = true
  try {
    const alive = await probeBackend()
    if (own !== generation) return
    if (alive) {
      await handleBackendUp()
    } else if (!isOffline.value) {
      // Lost connection between probes — enter offline + countdown.
      gotoOffline()
    } else {
      scheduleReconnect()
    }
  } finally {
    probing = false
  }
}

/**
 * Immediate reconnect attempt — the "Повторить" action. Probes the backend now
 * instead of waiting for the countdown to reach zero. A success goes back
 * online right away; a failure restarts a full countdown.
 */
export async function retryConnectionNow(): Promise<void> {
  if (window.erpDesktop?.queue?.mainSync) { await import('./desktopQueue').then(module => module.queueRequest({ action: 'sync', force: true })); return }
  if (recovering || probing) return
  // Set the deadline to now so the UI reads "probing…" while we wait.
  if (reconnectDeadline.value != null) reconnectDeadline.value = Date.now()
  await pingBackend()
}

function onWindowOffline(): void {
  // The browser has no network → the backend is unreachable right away.
  gotoOffline()
}

function onWindowOnline(): void {
  if (!canWork()) return
  // The network interface is back but the backend may still be down: only the
  // probe decides. Probe immediately instead of on the next scheduled tick.
  if (reconnectDeadline.value != null) {
    void retryConnectionNow()
  } else {
    void onlineHeartbeat()
  }
}

/**
 * Starts the legacy monitor for the desktop runtime. Idempotent — a second
 * call keeps the already-running monitor.
 */
export function startConnectionMonitor(): () => void {
  if (started || typeof window === 'undefined') return stopConnectionMonitor
  started = true
  generation++

  // navigator.onLine reported offline at init → start the reconnect countdown
  // (gotoOffline early-returns when already offline, so start it directly).
  if (isOffline.value) {
    scheduleReconnect()
    startCountdown()
  } else {
    startOnlineLoop()
  }

  window.addEventListener('online', onWindowOnline)
  window.addEventListener('offline', onWindowOffline)

  // HTTP cache fallback can detect an outage before the next health probe.
  stopOfflineWatch = watch(isOffline, (offline) => {
    if (offline) gotoOffline()
  })
  if (getCurrentScope()) onScopeDispose(stopConnectionMonitor)
  return stopConnectionMonitor
}

export function stopConnectionMonitor(): void {
  if (!started) return
  started = false
  generation++
  stopOnlineLoop()
  stopCountdown()
  stopOfflineWatch?.()
  stopOfflineWatch = null
  window.removeEventListener('online', onWindowOnline)
  window.removeEventListener('offline', onWindowOffline)
  reconnectDeadline.value = null
}
