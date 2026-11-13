import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
const fixture = vi.hoisted(() => ({ comments: vi.fn() }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop', offlineBootstrap: true } }))
vi.mock('@/offline/desktopQueue', () => ({ nativeQueue: { mainSync: true }, nativeSync: true, nativeCommands: vi.fn(async () => []), nativeEntry: vi.fn(), nativeDiscardPlan: vi.fn(), enqueueNative: vi.fn(), queueRequest: vi.fn() }))
vi.mock('./applicationClients', () => ({ createApplicationServices: () => ({ tasks: { comments: fixture.comments } }), applicationServices: { tasks: { comments: fixture.comments } } }))
import { usePlanningStore } from '../index'
import { isOffline } from '@/offline/state'
import { invalidateApiReads } from './apiReads'
let pinia: ReturnType<typeof createPinia>
beforeEach(() => {
 pinia = createPinia(); setActivePinia(pinia); vi.resetAllMocks(); invalidateApiReads(); isOffline.value = false
 fixture.comments.mockResolvedValue({ status: 200, data: { data: [{ id: 1, content: 'Loaded discussion' }], error: {} } })
})
afterEach(() => { disposePinia(pinia); isOffline.value = false })
it('a first native discussion read reaches the API instead of a cold snapshot-only request', async () => {
 const store = usePlanningStore(); await store.loadTaskComments(7)
 expect(fixture.comments).toHaveBeenCalledExactlyOnceWith(7, { signal: expect.any(AbortSignal) })
 expect(store.commentsByTask[7]?.[0]?.content).toBe('Loaded discussion')
 expect(store.commentsLoading).toBe(false); expect(store.commentsError).toBeNull()
})
it('an explicitly loaded empty discussion remains cached without an unnecessary request', async () => {
 const store = usePlanningStore(); store.commentsByTask[7] = []
 await store.loadTaskComments(7)
 expect(fixture.comments).not.toHaveBeenCalled(); expect(store.commentsByTask[7]).toEqual([])
})
it('refreshing an existing discussion requests a current foreground result', async () => {
 const store = usePlanningStore(); store.commentsByTask[7] = [{ id: 1, content: 'Old' }]
 await store.loadTaskComments(7, { fresh: true })
 expect(fixture.comments.mock.calls[0]?.[1]).not.toHaveProperty('headers')
 expect(store.commentsByTask[7]?.[0]?.content).toBe('Loaded discussion')
})
it('an unavailable cold offline discussion remains missing rather than becoming a successful empty list', async () => {
 const store = usePlanningStore(); isOffline.value = true
 fixture.comments.mockRejectedValueOnce(new Error('No saved discussion'))
 await store.loadTaskComments(7)
 expect(store.commentsByTask[7]).toBeUndefined(); expect(store.commentsError).toBe('No saved discussion'); expect(store.commentsLoading).toBe(false)
})
it('already loaded offline comments remain visible without a transport request', async () => {
 const store = usePlanningStore(); isOffline.value = true; store.commentsByTask[7] = [{ id: 1, content: 'Saved locally' }]
 await store.loadTaskComments(7, { fresh: true })
 expect(fixture.comments).not.toHaveBeenCalled(); expect(store.commentsByTask[7]?.[0]?.content).toBe('Saved locally')
})
it('a late discussion reply cannot reappear after the current account is reset', async () => {
 const store = usePlanningStore(); let complete!: (value: unknown) => void
 fixture.comments.mockReturnValueOnce(new Promise(resolve => { complete = resolve }))
 const pending = store.loadTaskComments(7)
 invalidateApiReads(); store.resetUserData()
 complete({ status: 200, data: { data: [{ id: 1, content: 'Previous account' }], error: {} } })
 await pending
 expect(store.commentsByTask[7]).toBeUndefined(); expect(store.commentsLoading).toBe(false)
})
