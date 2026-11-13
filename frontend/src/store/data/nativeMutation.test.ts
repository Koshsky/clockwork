import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AxiosError, AxiosHeaders } from 'axios'
const fixture = vi.hoisted(() => ({ enqueue: vi.fn(), refresh: vi.fn(), observe: vi.fn(), acknowledge: vi.fn() }))
vi.mock('@/offline/desktopQueue', () => ({ nativeQueue: {}, queuedResponse: (value: unknown) => (value as { headers?: Record<string, string> })?.headers?.['Operation-Status'] === 'queued' }))
vi.mock('@/store/data/nativeBaselines', () => ({ observe: fixture.observe, acknowledge: fixture.acknowledge }))
vi.mock('@/offline/outbox', () => ({ enqueueMutation: fixture.enqueue, isNetworkError: (error: AxiosError) => error.code === 'ERR_NETWORK' }))
vi.mock('@/offline/state', () => ({ isOffline: { value: false } }))
vi.mock('@/offline/sync', () => ({ scheduleDomainRefresh: fixture.refresh }))
vi.mock('@/utils', () => ({ apiErrorMessage: (body: { message?: string }) => body.message || 'Server error' }))
import { runLegacyMutation } from './legacyMutation'
import { hasActiveMutations } from '@/offline/mutationGuard'
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { expect(hasActiveMutations()).toBe(false) })
it('applies optimism only after the main-owned queue acknowledges durable commit', async () => {
  const options = { entity: 'task' as const, tempId: -1, call: vi.fn().mockResolvedValue({ status: 202, headers: { 'Operation-Status': 'queued' }, data: { data: null, error: {} } }), apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn() }
  expect((await runLegacyMutation(options)).status).toBe('queued')
  expect(options.optimistic).toHaveBeenCalledOnce(); expect(options.apply).not.toHaveBeenCalled(); expect(fixture.enqueue).not.toHaveBeenCalled()
  expect(options.call).toHaveBeenCalledWith({ headers: { 'X-Desktop-Temp-ID': '-1' } })
})
it('never creates a second renderer-owned intent after a native transport failure', async () => {
  const options = { entity: 'task' as const, call: async () => { throw new AxiosError('Network Error', 'ERR_NETWORK', { headers: new AxiosHeaders() }) }, apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn() }
  expect((await runLegacyMutation(options)).status).toBe('unknown')
  expect(options.optimistic).not.toHaveBeenCalled(); expect(fixture.enqueue).not.toHaveBeenCalled(); expect(options.onError).toHaveBeenCalledOnce()
})
it('reports a storage failure without falsely acknowledging or blindly retrying it', async () => {
  const options = { entity: 'task' as const, call: async () => { throw new AxiosError('Disk full', 'ERR_DESKTOP_STORAGE') }, apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn() }
  expect(await runLegacyMutation(options)).toMatchObject({ status: 'unknown', error: { kind: 'storage', message: 'Disk full' } })
  expect(options.optimistic).not.toHaveBeenCalled(); expect(fixture.enqueue).not.toHaveBeenCalled()
})

it('records observed local causality after optimistic application and returns the durable identity', async () => {
  const intent = { route: 'PUT /task/{id}', preconditions: { 'process:10': 'loaded' } }
  const options = { entity: 'task' as const, call: async () => ({ headers: { 'Operation-Status': 'queued' }, __erpMutation: intent, __erpOperationId: 'durable-operation', __erpTempId: -1, __erpContext: 'account-context' }), apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn() }
  expect(await runLegacyMutation(options)).toMatchObject({ status: 'queued', operationId: 'durable-operation' })
  expect(fixture.observe).toHaveBeenCalledWith(intent, 'durable-operation', -1, 'account-context')
  expect(options.optimistic.mock.invocationCallOrder[0]).toBeLessThan(fixture.observe.mock.invocationCallOrder[0]!)
})
it('adopts the confirmed baseline only after the authoritative DTO has been applied', async () => {
  const intent = { route: 'PUT /task/{id}' }, baseline = { 'process:10': 'confirmed' }, previous = { 'process:10': 'loaded' }, dto = { id: 1, title: 'Confirmed' }
  const options = { entity: 'task' as const, call: async () => ({ data: { data: dto, error: {} }, __erpMutation: intent, __erpBaseline: baseline, __erpPreconditions: previous, __erpContext: 'account-context' }), apply: vi.fn(), optimistic: vi.fn(), onError: vi.fn(), onConfirmed: vi.fn() }
  expect((await runLegacyMutation(options)).status).toBe('confirmed')
  expect(fixture.acknowledge).toHaveBeenCalledWith(intent, dto, baseline, previous, 'account-context')
  expect(options.apply.mock.invocationCallOrder[0]).toBeLessThan(fixture.acknowledge.mock.invocationCallOrder[0]!)
  expect(options.onConfirmed).toHaveBeenCalledOnce()
})
