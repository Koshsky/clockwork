import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { watch } from 'vue'

const fake = vi.hoisted(() => ({
  locked: vi.fn(), refresh: vi.fn(), login: vi.fn(), loggedOut: vi.fn(),
  listeners: new Set<(token: string) => void>(),
  sessions: new Set<(payload: { access?: string; refresh?: string }) => void>(),
}))
vi.mock('@/sessionSync', () => ({
  withRefreshLock: fake.locked,
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
    auth.enterOffline('admin')
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
    expect(await pending).toBe(true)
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

  it('keeps an explicitly entered offline session while the backend is unreachable', async () => {
    fake.loggedOut.mockReturnValue(true)
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(saved) })
    isOffline.value = true
    const auth = useAuthStore()
    expect(auth.enterOffline('admin')).toBe(true)
    expect(await auth.refreshSession()).toBe(true)
    expect(auth.isAuthenticated).toBe(true)
    expect(auth.sessionMode).toBe('offline')
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


it('persists refresh state and clears logout before publishing a successful manual login', async () => {
  fake.loggedOut.mockReturnValue(true)
  const user = { id: 42, username: 'admin', preset: 'admin' }
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(user), setItem: vi.fn() })
  fake.login.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'test-refresh', user } } })
  let persisted!: () => void
  vi.mocked(saveRefreshToken).mockImplementationOnce(() => new Promise(resolve => { persisted = resolve }))
  const auth = useAuthStore()
  const logoutWhenAuthenticated: boolean[] = []
  const stop = watch(() => auth.isAuthenticated, value => { if (value) logoutWhenAuthenticated.push(fake.loggedOut()) }, { flush: 'sync' })
  const login = auth.login('admin', 'test-password')
  await vi.advanceTimersByTimeAsync(1)
  expect(auth.isAuthenticated).toBe(false)
  expect(fake.loggedOut()).toBe(true)
  persisted()
  expect(await login).toBe(true)
  expect(auth.isAuthenticated).toBe(true)
  expect(logoutWhenAuthenticated).toEqual([false])
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

  it('does not log out other tabs when local session storage is temporarily unavailable', async () => {
    fake.locked.mockImplementation(async run => run())
    vi.mocked(loadRefreshToken).mockRejectedValueOnce(new Error('Storage blocked'))
    const auth = useAuthStore()
    auth.isAuthenticated = true
    setAccessToken(jwt(3600))
    expect(await auth.refreshSession()).toBe(false)
    expect(auth.isAuthenticated).toBe(true)
    expect(clearRefreshToken).not.toHaveBeenCalled()
    expect(fake.refresh).not.toHaveBeenCalled()
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

  it('prevents reuse in every tab when the server rotates but the new token cannot be saved', async () => {
    fake.locked.mockImplementation(async run => run())
    fake.refresh.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'rotated' } } })
    vi.mocked(saveRefreshToken).mockRejectedValueOnce(new Error('storage unavailable'))
    const auth = useAuthStore()
    auth.isAuthenticated = true
    expect(await auth.refreshSession()).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(setLoggedOut).toHaveBeenCalledTimes(1)
    expect(clearRefreshToken).not.toHaveBeenCalled()
    expect(getAccessToken()).toBe('')
  })


  it('does not restore authentication when logout occurs while persisting a rotation', async () => {
    fake.locked.mockImplementation(async run => run())
    fake.refresh.mockResolvedValue({ data: { data: { access_token: jwt(3600), refresh_token: 'rotated' } } })
    let persisted!: () => void
    vi.mocked(saveRefreshToken).mockImplementationOnce(() => new Promise(resolve => { persisted = resolve }))
    const auth = useAuthStore()
    const pending = auth.refreshSession()
    await vi.advanceTimersByTimeAsync(1)
    fake.loggedOut.mockReturnValue(true)
    persisted()
    expect(await pending).toBe(false)
    expect(auth.isAuthenticated).toBe(false)
    expect(getAccessToken()).toBe('')
  })

})
