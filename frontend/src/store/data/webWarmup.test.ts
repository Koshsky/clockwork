import { afterEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ refresh: vi.fn(), fresh: vi.fn() }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'web' } }))
vi.mock('@/offline/cache', () => ({ cacheGetFresh: fake.fresh }))
vi.mock('@/settings', () => ({ warmupEnabled: new Proxy({}, { get: (_, key) => key === 'task-plan' }) }))
vi.mock('@/store', () => ({
  apiConfig: () => ({}), useAuthStore: () => ({ user: { id: 1, preset: 'admin' }, isAuthenticated: true }),
  useAppStore: () => ({}), usePlanningStore: () => ({ refreshTaskPlanning: fake.refresh }), useTimesheetStore: () => ({}),
  useRbacStore: () => ({ permsLoaded: false, myPermissions: [] }),
}))
vi.mock('@/offline/outbox', async () => { const { ref } = await import('vue'); return { pendingCount: ref(0), pendingRefs: ref(new Set()) } })
vi.mock('@/offline/state', async () => { const { ref } = await import('vue'); return { isOffline: ref(false) } })
import { pullStaleCycle, resumeWarmup } from '@/offline/warmup'
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
it('does not borrow pathname freshness from another web query at a minute refresh', async () => {
  vi.useFakeTimers(); vi.stubGlobal('window', { setTimeout, clearTimeout })
  fake.refresh.mockResolvedValue(undefined)
  fake.fresh.mockResolvedValue({ ts: Date.now(), data: { owner: 'another query' } })
  resumeWarmup()
  const pending = pullStaleCycle(); await vi.runAllTimersAsync()
  expect(await pending).toBe(1)
  expect(fake.refresh).toHaveBeenCalledExactlyOnceWith(true)
  expect(fake.fresh).not.toHaveBeenCalled()
})
