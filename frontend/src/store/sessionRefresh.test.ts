import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

const fake = vi.hoisted(() => ({
  locked: vi.fn(), refresh: vi.fn(), login: vi.fn(), loggedOut: vi.fn(),
  listeners: new Set<(token: string) => void>(),
  sessions: new Set<(payload: { access?: string; refresh?: string }) => void>(),
}))
vi.mock('@/sessionSync', () => ({
  withRefreshLock: fake.locked, withSessionLock: (run: () => Promise<boolean>) => run(),
  sessionEpoch: () => '', advanceSessionEpoch: () => '', subscribeEpoch: () => () => {},
  sessionUncertain: () => false, markSessionUncertain: vi.fn(),
  publishSession: vi.fn(), subscribeSession: (cb: (payload: { access?: string; refresh?: string }) => void) => { fake.sessions.add(cb); return () => fake.sessions.delete(cb) },
  subscribeToken: (cb: (token: string) => void) => { fake.listeners.add(cb); return () => fake.listeners.delete(cb) },
}))
vi.mock('@/loggedOut', () => ({ isLoggedOut: fake.loggedOut, clearLoggedOut: vi.fn(() => fake.loggedOut.mockReturnValue(false)), setLoggedOut: vi.fn() }))
vi.mock('@/offline/session', () => ({ loadRefreshToken: vi.fn(async () => 'saved'), saveRefreshToken: vi.fn(async () => {}), clearRefreshToken: vi.fn(async () => {}) }))
vi.mock('@/api', async original => ({
  ...await original<typeof import('@/api')>(),
  AuthApi: class { authRefreshPost(...args: unknown[]) { return fake.refresh(...args) } authLoginPost(...args: unknown[]) { return fake.login(...args) } },
}))
import { useAuthStore, usePlanningStore } from './index'
import { getAccessToken, setAccessToken } from '@/token'
import { isOffline } from '@/offline/state'
import { setLoggedOut } from '@/loggedOut'
import { saveRefreshToken, clearRefreshToken, loadRefreshToken } from '@/offline/session'

const jwt = (offset: number) => `e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + offset }))}.signature`

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fake.listeners.clear()
  fake.sessions.clear()
  fake.loggedOut.mockReturnValue(false)
  fake.locked.mockResolvedValue(null)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  vi.stubGlobal('window', {
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    setInterval: vi.fn(() => 1),
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  setActivePinia(createPinia())
  isOffline.value = false
  setAccessToken(jwt(-60))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setAccessToken(null) })

describe('waiting for a sibling session', () => {
  it('lets explicit recovery wait for a pending startup renewal', async () => {
    fake.locked.mockImplementation(async run => run())
    let reply!: (value: unknown) => void
    fake.refresh.mockImplementation(() => new Promise(resolve => { reply = resolve }))
    const auth = useAuthStore()
    const refresh = auth.refreshSession()
    let settled = false
    const waiting = auth.waitForSessionRefresh().then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    reply({ data: { data: { access_token: jwt(3600) } } })
    await Promise.all([refresh, waiting])
    expect(settled).toBe(true)
    expect(fake.refresh).toHaveBeenCalledTimes(1)
  })

  it('coalesces offline-session recovery with a concurrent explicit refresh', async () => {
    fake.locked.mockImplementation(async run => run())
    let reply!: (value: unknown) => void
    fake.refresh.mockImplementation(() => new Promise(resolve => { reply = resolve }))
    isOffline.value = true
    const auth = useAuthStore()
    expect(await auth.enterOffline('admin')).toBe(false)
    isOffline.value = false
    const pending = auth.refreshSession()
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    reply({ data: { data: { access_token: jwt(3600) } } })
    expect(await pending).toBe(true)
    expect(auth.accessExpired()).toBe(false)
  })

  it('does not report success after two seconds with an expired token', async () => {
    const auth = useAuthStore()
    let settled = false
    const pending = auth.refreshSession().then(ok => { settled = true; return ok })
    await vi.advanceTimersByTimeAsync(2300)
    expect(settled).toBe(false)
    expect(fake.locked).toHaveBeenCalledTimes(2)
    for (const listener of fake.listeners) listener(jwt(3600))
    expect(await pending).toBe(true)
    expect(auth.accessExpired()).toBe(false)
  })

  it('ignores expired broadcasts while waiting for a usable session', async () => {
    const auth = useAuthStore()
    let settled = false
    const pending = auth.refreshSession().then(ok => { settled = true; return ok })
    await vi.advanceTimersByTimeAsync(1)
    for (const listener of fake.listeners) listener(jwt(-30))
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    for (const listener of fake.listeners) listener(jwt(3600))
    expect(await pending).toBe(true)
  })

  it('retries ownership after the sibling disappears', async () => {
    fake.locked.mockResolvedValueOnce(null).mockImplementation(async run => run())
    fake.refresh.mockResolvedValue({ data: { data: { access_token: jwt(3600) } } })
    const auth = useAuthStore()
    const pending = auth.refreshSession()
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBe(true)
    expect(fake.refresh).toHaveBeenCalledTimes(1)
    expect(auth.accessExpired()).toBe(false)
  })

  it('stops attempting renewal if connectivity is lost during the wait', async () => {
    const pending = useAuthStore().refreshSession()
    await vi.advanceTimersByTimeAsync(1)
    isOffline.value = true
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBe(false)
    expect(fake.locked).toHaveBeenCalledTimes(1)
    expect(fake.refresh).not.toHaveBeenCalled()
  })

  it('does not restore a session logged out while another tab was refreshing', async () => {
    const pending = useAuthStore().refreshSession()
    await vi.advanceTimersByTimeAsync(1)
    fake.loggedOut.mockReturnValue(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(await pending).toBe(false)
    expect(fake.refresh).not.toHaveBeenCalled()
  })
})


describe('cached identity after a cross-tab logout', () => {
  const saved = { id: 42, username: 'admin', preset: 'admin' }

  it('does not treat a cached profile as an online session when logout is recorded', () => {
    fake.loggedOut.mockReturnValue(true)
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved) })
    const auth = useAuthStore()
    expect(auth.user?.id).toBe(42)
    expect(auth.isAuthenticated).toBe(false)
  })

  it('invalidates stale in-memory authentication without revoking or deleting the shared session', async () => {
    const auth = useAuthStore()
    auth.user = saved
    auth.isAuthenticated = true
    usePlanningStore().taskPlanning = { processes: [{ id: 1 }] }
    setAccessToken(jwt(3600))
    fake.loggedOut.mockReturnValue(true)

    expect(await auth.refreshSession()).toBe(false)

    expect(auth.isAuthenticated).toBe(false)
    expect(auth.user).toEqual(saved)
    expect(usePlanningStore().taskPlanning).toBeNull()
    expect(getAccessToken()).toBe('')
    expect(fake.refresh).not.toHaveBeenCalled()
    expect(fake.locked).not.toHaveBeenCalled()
    expect(clearRefreshToken).not.toHaveBeenCalled()
  })

  it('refuses web offline login based only on an editable cached identity', async () => {
    fake.loggedOut.mockReturnValue(true)
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved) })
    isOffline.value = true
    const auth = useAuthStore()
    expect(await auth.enterOffline('admin')).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(auth.sessionMode).toBe('online')
    expect(fake.refresh).not.toHaveBeenCalled()
  })
})


it('discards a refresh response that arrives after logout was recorded', async () => {
  let reply!: (value: unknown) => void
  fake.locked.mockImplementation(async run => run())
  fake.refresh.mockImplementation(() => new Promise(resolve => { reply = resolve }))
  const auth = useAuthStore()
  auth.user = { id: 42, username: 'admin', preset: 'admin' }
  auth.isAuthenticated = true
  const pending = auth.refreshSession()
  await vi.advanceTimersByTimeAsync(1)
  fake.loggedOut.mockReturnValue(true)
  reply({ data: { data: { access_token: jwt(3600), user: auth.user } } })
  expect(await pending).toBe(false)
  expect(auth.isAuthenticated).toBe(false)
  expect(getAccessToken()).toBe('')
})


it('clears logout before publishing a cookie login without storing the returned legacy refresh', async () => {
  fake.loggedOut.mockReturnValue(true)
  const user = { id: 42, username: 'admin', preset: 'admin' }
  fake.login.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'test-refresh', user }, error: {} } })
  const auth = useAuthStore()
  const logoutWhenAuthenticated: boolean[] = []
  const stop = watch(() => auth.isAuthenticated, value => { if (value) logoutWhenAuthenticated.push(fake.loggedOut()) }, { flush: 'sync' })
  expect(await auth.login('admin', 'test-password')).toBe(true)
  expect(auth.isAuthenticated).toBe(true)
  expect(logoutWhenAuthenticated).toEqual([false])
  expect(saveRefreshToken).not.toHaveBeenCalled()
  stop()
})


describe('cross-tab session races', () => {
  it('does not overwrite shared refresh state when a delayed broadcast arrives', () => {
    useAuthStore()
    const access = jwt(3600)
    for (const listener of fake.sessions) listener({ access, refresh: 'already-rotated-old-refresh' })
    expect(getAccessToken()).toBe(access)
    expect(saveRefreshToken).not.toHaveBeenCalled()
  })

  it('ignores broadcasts after logout', () => {
    useAuthStore()
    setAccessToken(null)
    fake.loggedOut.mockReturnValue(true)
    for (const listener of fake.sessions) listener({ access: jwt(3600), refresh: 'old-session' })
    expect(getAccessToken()).toBe('')
    expect(saveRefreshToken).not.toHaveBeenCalled()
  })

  it('stops waiting for a frozen lock owner without deleting the session', async () => {
    const auth = useAuthStore()
    const pending = auth.refreshSession()
    await vi.advanceTimersByTimeAsync(6500)
    expect(await Promise.race([pending, Promise.resolve('still waiting')])).toBe(false)
    expect(clearRefreshToken).not.toHaveBeenCalled()
    expect(fake.refresh).not.toHaveBeenCalled()
  })

  it('does not mistake its existing rejected token for a new sibling token', async () => {
    const rejected = jwt(3600)
    setAccessToken(rejected)
    const auth = useAuthStore()
    let settled = false
    const pending = auth.refreshSession().then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    for (const listener of fake.listeners) listener(jwt(7200))
    expect(await pending).toBe(true)
  })

  it('does not consult IndexedDB when its legacy session store is unavailable', async () => {
    fake.locked.mockImplementation(async run => run())
    vi.mocked(loadRefreshToken).mockImplementationOnce(async () => { throw new Error('must not read storage') })
    fake.refresh.mockResolvedValueOnce({ data: { data: { access_token: jwt(3600) } } })
    const auth = useAuthStore()
    auth.isAuthenticated = true
    setAccessToken(jwt(3600))
    expect(await auth.refreshSession()).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
    expect(clearRefreshToken).not.toHaveBeenCalled()
    expect(loadRefreshToken).not.toHaveBeenCalled()
  })

  it('ignores an older valid broadcast when waiting to replace a rejected token', async () => {
    setAccessToken(jwt(7200))
    const auth = useAuthStore()
    let settled = false
    const pending = auth.refreshSession().then(value => { settled = true; return value })
    await vi.advanceTimersByTimeAsync(1)
    for (const listener of fake.listeners) listener(jwt(3600))
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(6500)
    expect(await pending).toBe(false)
  })

  it('preserves the session on a temporary refresh server error', async () => {
    fake.locked.mockImplementation(async run => run())
    fake.refresh.mockRejectedValueOnce({ response: { status: 503 } })
    const auth = useAuthStore()
    auth.isAuthenticated = true
    expect(await auth.refreshSession()).toBe(false)
    expect(auth.isAuthenticated).toBe(true)
    expect(setLoggedOut).not.toHaveBeenCalled()
    expect(clearRefreshToken).not.toHaveBeenCalled()
  })

  it('ignores legacy refresh tokens in a successful cookie response', async () => {
    fake.locked.mockImplementation(async run => run())
    fake.refresh.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'rotated' } } })
    const auth = useAuthStore()
    expect(await auth.refreshSession()).toBe(true)
    expect(saveRefreshToken).not.toHaveBeenCalled()
    expect(loadRefreshToken).not.toHaveBeenCalled()
    expect(getAccessToken()).not.toBe('')
  })

  it('has no IndexedDB persistence window that could resurrect a logged-out cookie session', async () => {
    fake.locked.mockImplementation(async run => run())
    fake.refresh.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'rotated' } } })
    const auth = useAuthStore()
    expect(await auth.refreshSession()).toBe(true)
    expect(saveRefreshToken).not.toHaveBeenCalled()
    fake.loggedOut.mockReturnValue(true)
    expect(await auth.refreshSession()).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(getAccessToken()).toBe('')
  })

})
