import { beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  const request = vi.fn()
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { erpDesktop: { queue: { request } } } })
  return { request, state: { contextId: 'original', user: { id: 7 }, server: 'https://native.example/api/v1' } }
})
vi.mock('@/store/data/nativeBaselines', () => ({ capture: () => ({ 'process:10': 'loaded-row-token' }) }))
vi.mock('@/i18n', () => ({ t: (key: string) => key }))
vi.mock('@/session/desktop', () => ({ prepareDesktopSession: async () => fixture.state, desktopSession: { status: async () => fixture.state } }))
import { queueRequest, nativeEntry, enqueueNative, queuedResponse, desktopQueueMessage, nativeDiscardPlan } from './desktopQueue'

beforeEach(() => { fixture.request.mockReset(); fixture.state = { contextId: 'original', user: { id: 7 }, server: 'https://native.example/api/v1' } })
describe('native queue boundary', () => {
  it('binds controls to the current main-owned session context', async () => {
    fixture.request.mockResolvedValue([])
    expect(await queueRequest({ action: 'list' })).toEqual([])
    expect(fixture.request).toHaveBeenCalledWith({ action: 'list', contextId: 'original' })
  })
  it('rejects a reply after switching the authenticated context', async () => {
    fixture.request.mockImplementation(async () => { fixture.state = { ...fixture.state, contextId: 'next' }; return [] })
    await expect(queueRequest({ action: 'list' })).rejects.toThrow('SESSION_CONTEXT_CHANGED')
  })
  it('maps an unknown delivery outcome to a user-facing message', async () => {
    fixture.request.mockRejectedValue(new Error('STORAGE_OUTCOME_UNKNOWN'))
    await expect(queueRequest({ action: 'discard', operationIds: ['operation'] })).rejects.toThrow(desktopQueueMessage('STORAGE_OUTCOME_UNKNOWN'))
  })
  it('refuses rebasing an old queue request onto another server', async () => {
    await expect(enqueueNative({ method: 'PUT', url: 'https://another.example/api/v1/task/1', body: {} })).rejects.toThrow('COMMAND_INVALID_SERVER')
    expect(fixture.request).not.toHaveBeenCalled()
  })
  it('keeps a temporary path and stable operation ID in an enqueue intent', async () => {
    fixture.request.mockResolvedValue({ queued: true })
    await enqueueNative({ method: 'PUT', url: 'https://native.example/api/v1/task/-9001', body: { title: 'Local' }, idempotencyKey: 'stable-id' })
    expect(fixture.request).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'stable-id', input: expect.objectContaining({ route: 'PUT /task/{id}', path: { id: '-9001' }, body: { title: 'Local' }, preconditions: { 'process:10': 'loaded-row-token' } }) }))
  })
  it('does not treat an ordinary HTTP success as a local queue acknowledgement', () => {
    expect(queuedResponse({ headers: {} })).toBe(false)
    expect(queuedResponse({ headers: { 'Operation-Status': 'queued' } })).toBe(true)
  })
  it('rebuilds day-range query fields for the existing queue screen', () => {
    const row = nativeEntry({ operationId: 'period', input: { route: 'DELETE /user/{id}/days', path: { id: '7' }, query: { start_date: '2026-11-01', end_date: '2026-11-02' } }, status: 'queued', http: { tempId: null, createdAt: 1, discarded: false } })
    expect(row.entity).toBe('period'); expect(row.url).toContain('start_date=2026-11-01')
  })
  it('keeps a rejected server reason visible without dropping the command', () => {
    const row = nativeEntry({ operationId: 'denied', input: { route: 'PUT /task/{id}', path: { id: '3' }, body: {} }, status: 'rejected', http: { tempId: null, createdAt: 1, discarded: false, error: { message: 'Insufficient permission' } } })
    expect(row.quarantined).toBe(true); expect(row.failed?.message).toBe('Insufficient permission')
  })
})

it('includes transitive unsent dependents in the reviewed discard set', () => {
  const rows: Parameters<typeof nativeDiscardPlan>[0] = [
    { operationId: 'parent', status: 'conflict' }, { operationId: 'child', status: 'queued', dependencies: ['parent'] },
    { operationId: 'last', status: 'queued', dependencies: ['child'] }, { operationId: 'unrelated', status: 'queued' },
  ]
  expect(nativeDiscardPlan(rows)).toEqual(['parent', 'child', 'last'])
})
it('never offers unknown commands as independent discard roots', () => {
  expect(nativeDiscardPlan([{ operationId: 'unknown', status: 'unknown' }])).toEqual([])
})
it('rejects a reviewed control action after an account change', async () => {
  fixture.request.mockResolvedValue(null)
  await expect(queueRequest({ action: 'discard', contextId: 'old-account', operationIds: ['operation'] })).rejects.toThrow('SESSION_CONTEXT_CHANGED')
  expect(fixture.request).not.toHaveBeenCalled()
})
