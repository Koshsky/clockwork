import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
const fake = vi.hoisted(() => ({ action: vi.fn() }))
vi.mock('@/session/desktop', async () => {
  const { ref } = await import('vue')
  return { desktopSession: {}, desktopSessionState: ref(null), desktopAction: fake.action }
})
vi.mock('@/offline/warmup', () => ({ scheduleWarmup: vi.fn() }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop', optionalStorage: false } }))
import { useAuthStore } from './index'
import { desktopSessionState, type SessionState } from '@/session/desktop'
import { localDataAvailability } from '@/platform/state'
import { getAccessToken, setAccessToken } from '@/token'
const online: SessionState = { server: 'https://erp.example/api/v1', user: { id: 7, username: 'verified' }, mode: 'online', persistent: true, offlineAvailable: true, needsLogin: false, contextId: 'c', revision: 1, expiresAt: Date.now() + 60000 }
beforeEach(() => {
  vi.clearAllMocks(); setActivePinia(createPinia())
  desktopSessionState.value = null; localDataAvailability.value = 'unknown'; setAccessToken(null)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  fake.action.mockResolvedValue(online)
})
afterEach(() => vi.unstubAllGlobals())
it('does not unlock legacy desktop screens before durable business storage is ready', () => {
  desktopSessionState.value = online
  const auth = useAuthStore()
  expect(auth.isAuthenticated).toBe(false)
  localDataAvailability.value = 'available'
  expect(auth.isAuthenticated).toBe(true)
  expect(getAccessToken()).toBe('')
})
it('reports unavailable business storage without sending a login or pretending edits are durable', async () => {
  localDataAvailability.value = 'unavailable'
  const auth = useAuthStore()
  expect(await auth.login('verified', 'password')).toBe(false)
  expect(fake.action).not.toHaveBeenCalled()
  expect(auth.isAuthenticated).toBe(false)
})
it('main session remains token-free in the renderer on successful login', async () => {
  localDataAvailability.value = 'available'
  const auth = useAuthStore()
  expect(await auth.login('verified', 'password')).toBe(true)
  expect(auth.user?.id).toBe(7)
  expect(getAccessToken()).toBe('')
})
it('a signed-out main service cannot be replaced with a user edited in localStorage', () => {
  localDataAvailability.value = 'available'
  vi.stubGlobal('localStorage', { getItem: () => '{"id":1,"preset":"admin"}', setItem: vi.fn(), removeItem: vi.fn() })
  desktopSessionState.value = { ...online, mode: 'signedOut', user: null, offlineAvailable: false }
  const auth = useAuthStore()
  expect(auth.isAuthenticated).toBe(false)
  expect(auth.user).toBeNull()
})
it('does not expose native protocol codes as login error copy', async () => {
  localDataAvailability.value = 'available'
  fake.action.mockRejectedValue(new Error('SESSION_UNAVAILABLE'))
  const auth = useAuthStore()
  expect(await auth.login('verified', 'password')).toBe(false)
  expect(auth.error).not.toContain('SESSION_')
  expect(auth.error).toBeTruthy()
})
