/** Web storage carries coordination metadata, never credentials. */
const LOCK_KEY = 'mvs_erp_refresh_lock'
const EPOCH_KEY = 'mvs_erp_session_epoch'
const UNCERTAIN_KEY = 'mvs_erp_session_uncertain'
const LOCK_TTL_MS = 15_000
export const REFRESH_OWNER = crypto.randomUUID()
for (const key of ['mvs_erp_session_state', 'mvs_erp_session_token']) {
  try { localStorage.removeItem(key) } catch { /* Legacy broadcast credentials are never consumed. */ }
}
const channel = (() => { try { return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('mvs_erp_session') } catch { return null } })()
let memoryEpoch = ''
interface RefreshLock { owner: string; ts: number }
function readLock(): RefreshLock | null {
  try {
    const value = JSON.parse(localStorage.getItem(LOCK_KEY) || 'null') as RefreshLock | null
    return value && typeof value.owner === 'string' && Number.isFinite(value.ts) ? value : null
  } catch { return null }
}
export function tryAcquireRefreshLock(): boolean {
  const now = Date.now(), lock = readLock()
  if (lock && now >= lock.ts && now - lock.ts < LOCK_TTL_MS && lock.owner !== REFRESH_OWNER) return false
  try { localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: REFRESH_OWNER, ts: now })); return true } catch { return false }
}
export function releaseRefreshLock(): void {
  if (readLock()?.owner === REFRESH_OWNER) { try { localStorage.removeItem(LOCK_KEY) } catch { /* Lease expires. */ } }
}
export async function withRefreshLock(refresh: () => Promise<boolean>): Promise<boolean | null> {
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request('mvs_erp_refresh', { ifAvailable: true }, lock => lock ? refresh() : null)
  if (!tryAcquireRefreshLock()) return null
  try {
    // A competing storage claim must settle before sending a credential.
    await new Promise(resolve => setTimeout(resolve, 20))
    if (readLock()?.owner !== REFRESH_OWNER) return null
    return await refresh()
  } finally { releaseRefreshLock() }
}
export async function withSessionLock(run: () => Promise<boolean>): Promise<boolean> {
  const deadline = Date.now() + 16000
  while (Date.now() < deadline) {
    const value = await withRefreshLock(run)
    if (value !== null) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('SESSION_BUSY')
}
export function sessionEpoch(): string { try { return localStorage.getItem(EPOCH_KEY) || memoryEpoch } catch { return memoryEpoch } }
export function advanceSessionEpoch(): string {
  const value = crypto.randomUUID()
  memoryEpoch = value
  try { localStorage.setItem(EPOCH_KEY, value) } catch { /* Web Locks still serialize supported browsers. */ }
  try { channel?.postMessage({ type: 'epoch', epoch: value }) } catch { /* Storage events provide the other metadata path. */ }
  return value
}
export function sessionUncertain(): boolean { try { return localStorage.getItem(UNCERTAIN_KEY) === '1' } catch { return false } }
export function markSessionUncertain(value: boolean): boolean {
  try { if (value) localStorage.setItem(UNCERTAIN_KEY, '1'); else localStorage.removeItem(UNCERTAIN_KEY); return true } catch { return false }
}
export interface SessionPayload { access?: string; user?: import('@/api').DtoUserInfo; epoch?: string }
export function publishSession(payload: SessionPayload): void {
  try { channel?.postMessage({ type: 'session', access: payload.access, user: payload.user, epoch: sessionEpoch() }) } catch { /* Other tabs can refresh the cookie under the lock. */ }
}
export function subscribeSession(cb: (payload: SessionPayload) => void): () => void {
  const onMessage = (event: MessageEvent<SessionPayload & { type?: string }>) => {
    if (event.data?.type === 'session' && event.data.epoch === sessionEpoch() && typeof event.data.access === 'string') cb(event.data)
  }
  channel?.addEventListener('message', onMessage)
  return () => channel?.removeEventListener('message', onMessage)
}
export function publishToken(token: string): void { publishSession({ access: token }) }
export function subscribeToken(cb: (token: string) => void): () => void { return subscribeSession(payload => { if (payload.access) cb(payload.access) }) }
export function subscribeEpoch(cb: () => void): () => void {
  const listener = (event: StorageEvent) => { if (event.key === EPOCH_KEY || event.key === 'mvs_erp_logged_out' && event.newValue === '1') cb() }
  const message = (event: MessageEvent<{ type?: string; epoch?: string }>) => {
    if (event.data?.type === 'epoch' && typeof event.data.epoch === 'string') { memoryEpoch = event.data.epoch; cb() }
  }
  channel?.addEventListener('message', message)
  window.addEventListener('storage', listener)
  return () => { window.removeEventListener('storage', listener); channel?.removeEventListener('message', message) }
}

import.meta.hot?.dispose(() => channel?.close())
