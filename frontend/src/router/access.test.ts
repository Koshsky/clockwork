import { beforeEach, afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  guard: null as null | ((route: { name: string; fullPath: string; meta: { requiresAuth: boolean } }) => Promise<unknown>),
  auth: { isAuthenticated: true, user: { preset: 'vp' }, accessExpired: () => false, refreshSession: vi.fn() },
  rbac: { permsLoaded: false, myPermissions: [], can: vi.fn(), loadMyPermissions: vi.fn() },
  capabilities: { kind: 'web', sessionRestoreBoundMs: 3000 },
}))
vi.mock('vue-router', () => ({ createWebHistory: vi.fn(), createRouter: () => ({ beforeEach: (guard: typeof state.guard) => { state.guard = guard } }) }))
vi.mock('@/store', () => ({ useAuthStore: () => state.auth, useRbacStore: () => state.rbac }))
vi.mock('@/offline/state', () => ({ isOffline: { value: false } }))
vi.mock('@/platform/context', () => ({ platformCapabilities: state.capabilities }))
vi.mock('@/loggedOut', () => ({ isLoggedOut: () => false }))
vi.mock('@/layouts/MainLayout.vue', () => ({ default: {} }))
vi.mock('@/layouts/AuthLayout.vue', () => ({ default: {} }))
import './index'

const visit = () => state.guard!({ name: 'planner', fullPath: '/planner', meta: { requiresAuth: true } })
beforeEach(() => {
  vi.useFakeTimers()
  state.auth.isAuthenticated = true
  state.rbac.permsLoaded = false
  state.capabilities.kind = 'web'
  state.rbac.can.mockReset().mockReturnValue(false)
  state.rbac.loadMyPermissions.mockReset().mockResolvedValue(false)
})
afterEach(() => { vi.useRealTimers() })

it('keeps the requested web page when the permissions API is unavailable', async () => {
  expect(await visit()).toBe(true)
  expect(state.rbac.can).not.toHaveBeenCalled()
})
it('does not treat a suspended sibling session renewal as a permission denial', async () => {
  state.rbac.loadMyPermissions.mockReturnValue(new Promise(() => {}))
  const navigation = visit()
  await vi.advanceTimersByTimeAsync(3000)
  expect(await navigation).toBe(true)
  expect(state.rbac.can).not.toHaveBeenCalled()
})
it.each([true, false])('uses verified backend permissions, allowed=%s', async allowed => {
  state.rbac.permsLoaded = true
  state.rbac.can.mockReturnValue(allowed)
  expect(await visit()).toEqual(allowed ? true : { name: 'profile' })
})
it('rechecks permissions that arrive during the navigation wait', async () => {
  state.rbac.loadMyPermissions.mockImplementation(async () => { state.rbac.permsLoaded = true; return true })
  expect(await visit()).toEqual({ name: 'profile' })
})
it('preserves the existing desktop role fallback while its local matrix is unavailable', async () => {
  state.capabilities.kind = 'desktop'
  expect(await visit()).toBe(true)
})
it('never admits an unauthenticated session through the unavailable-matrix path', async () => {
  state.auth.isAuthenticated = false
  state.auth.refreshSession.mockResolvedValue(false)
  expect(await visit()).toEqual({ name: 'login', query: { redirect: '/planner' } })
  expect(state.rbac.loadMyPermissions).not.toHaveBeenCalled()
})
