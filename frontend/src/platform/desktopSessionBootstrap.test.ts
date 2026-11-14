import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ prepare: vi.fn(), refresh: vi.fn() }))
vi.mock('@/session/desktop', () => ({ desktopSession: { refresh: fake.refresh }, prepareDesktopSession: fake.prepare }))
vi.mock('@/offline/cache', () => ({ ensureCacheVersion: vi.fn() }))
vi.mock('@/offline/sync', () => ({ initOfflineSync: vi.fn(), startSessionMaintenance: vi.fn(), stopDomainRefresh: vi.fn(), resumeDomainRefresh: vi.fn() }))
vi.mock('@/offline/connection', () => ({ startConnectionMonitor: () => () => {}, retryConnectionNow: vi.fn() }))
vi.mock('@/offline/warmup', () => ({ resumeWarmup: vi.fn(), stopWarmup: vi.fn() }))
import { createDesktopRuntime } from './desktop'
beforeEach(() => vi.clearAllMocks())
it.each([
  ['signedOut', false, 0, false],
  ['online', false, Date.now() + 600000, false],
  ['online', false, 0, true],
  ['offline', false, 0, true],
  ['offline', true, 0, false],
])('restores %s session only when needed (uncertain=%s)', async (mode, needsLogin, expiresAt, renew) => {
  fake.prepare.mockResolvedValue({ mode, needsLogin, expiresAt })
  const runtime = createDesktopRuntime()
  await runtime.start()
  expect(fake.refresh).toHaveBeenCalledTimes(renew ? 1 : 0)
  runtime.stop()
})
