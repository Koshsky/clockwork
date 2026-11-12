import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const fake = vi.hoisted(() => ({ login: vi.fn(), loggedOut: true, optionalStorage: false }))
vi.mock('@/api', async original => ({
  ...await original<typeof import('@/api')>(),
  AuthApi: class { authLoginPost(...args: unknown[]) { return fake.login(...args) } },
}))
vi.mock('@/platform/context', () => ({ platformCapabilities: { get optionalStorage() { return fake.optionalStorage } } }))
vi.mock('@/sessionSync', () => ({ withRefreshLock: vi.fn(), withSessionLock: (run: () => Promise<boolean>) => run(), sessionEpoch: () => '', advanceSessionEpoch: () => '', subscribeEpoch: () => () => {}, markSessionUncertain: vi.fn(), sessionUncertain: () => false, publishSession: vi.fn(), subscribeSession: () => () => {}, subscribeToken: () => () => {} }))
vi.mock('@/loggedOut', () => ({ isLoggedOut: () => fake.loggedOut, clearLoggedOut: () => { fake.loggedOut = false }, setLoggedOut: vi.fn() }))
vi.mock('@/offline/warmup', () => ({ scheduleWarmup: vi.fn() }))
vi.mock('@/offline/outbox', () => ({ pruneForeignOutbox: vi.fn(async () => {}), pendingRefs: new Set() }))

import { useAuthStore } from './index'
import { setAccessToken } from '@/token'
import { isOffline } from '@/offline/state'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  fake.loggedOut = true
  fake.optionalStorage = false
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  setActivePinia(createPinia())
  setAccessToken(null)
  isOffline.value = false
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); setAccessToken(null) })

it('completes cookie login without waiting for an IndexedDB that never opens', async () => {
  vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) })
  fake.login.mockResolvedValue({ data: { data: { access_token: 'test-access', refresh_token: 'test-refresh' } } })
  const auth = useAuthStore()
  const login = auth.login('admin', 'test-password')
  await vi.advanceTimersByTimeAsync(1)
  expect(fake.login).toHaveBeenCalledTimes(1)
  expect(auth.loading).toBe(false)
  await vi.advanceTimersByTimeAsync(4000)
  expect(await login).toBe(true)
  expect(auth.loading).toBe(false)
  expect(auth.isAuthenticated).toBe(true)
  expect(auth.error).toBeNull()
  expect(indexedDB.open).not.toHaveBeenCalled()
  expect(fake.loggedOut).toBe(false)
})

it('shows an invalid-credentials response without opening local storage or leaving login busy', async () => {
  const open = vi.fn()
  vi.stubGlobal('indexedDB', { open })
  fake.login.mockRejectedValue(new Error('Invalid credentials'))
  const auth = useAuthStore()
  expect(await auth.login('invalid', 'invalid')).toBe(false)
  expect(auth.loading).toBe(false)
  expect(auth.error).toBe('Invalid credentials')
  expect(open).not.toHaveBeenCalled()
})

it('allows web login through the existing cookie when IndexedDB never opens', async () => {
  fake.optionalStorage = true
  vi.stubGlobal('indexedDB', { open: vi.fn(() => ({})) })
  fake.login.mockResolvedValue({ data: { data: { access_token: 'test-access', refresh_token: 'test-refresh' } } })
  const auth = useAuthStore()
  const login = auth.login('admin', 'test-password')
  await vi.advanceTimersByTimeAsync(4001)
  expect(await login).toBe(true)
  expect(auth.loading).toBe(false)
  expect(auth.isAuthenticated).toBe(true)
  expect(indexedDB.open).not.toHaveBeenCalled()
})
