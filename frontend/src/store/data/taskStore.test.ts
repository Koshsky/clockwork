import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from 'vue'
import { createPinia, disposePinia, setActivePinia } from 'pinia'
import type { CommandResult, ReadResult, TaskDataPort } from '@/data/contracts'
import { taskDataKey } from '@/data/taskData'
import type { DtoTaskPlanning, DtoTaskResponse } from '@/api'
import { pendingRefs } from '@/offline/outbox'
import { hasActiveMutations } from '@/offline/mutationGuard'
import { usePlanningStore } from '../index'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const oldPlanning = () => ({ processes: [{ id: 10, tasks: [{ id: 7, title: 'Old', start_date: '2026-11-09', end_date: '2026-11-15' }] }] })
const snapshot = (title: string): ReadResult<DtoTaskPlanning> => ({
  status: 'ok', source: 'refresh', data: { processes: [{ id: 10, tasks: [{ id: 7, title }] }] },
})
const failure = { kind: 'forbidden' as const, message: 'Forbidden by server', code: 'FORBIDDEN' }

let pinia: ReturnType<typeof createPinia>
let planning: ReturnType<typeof usePlanningStore>
let port: { readPlanning: ReturnType<typeof vi.fn<TaskDataPort['readPlanning']>>; update: ReturnType<typeof vi.fn<TaskDataPort['update']>> }

beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  port = {
    readPlanning: vi.fn<TaskDataPort['readPlanning']>().mockResolvedValue(snapshot('Loaded')),
    update: vi.fn<TaskDataPort['update']>().mockResolvedValue({ status: 'confirmed', data: { id: 7 } }),
  }
  const app = createApp({})
  app.use(pinia)
  app.provide(taskDataKey, port)
  planning = app.runWithContext(() => usePlanningStore(pinia))
  pendingRefs.value = new Set()
})
afterEach(() => {
  disposePinia(pinia)
  pendingRefs.value = new Set()
  expect(hasActiveMutations()).toBe(false)
})

describe('task planning through an injected data port', () => {
  it('loads a snapshot and changes the same task without a transport dependency', async () => {
    await planning.loadTaskPlanning()
    expect(port.readPlanning).toHaveBeenCalledExactlyOnceWith({ source: 'snapshot' })
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('Loaded')
    expect(await planning.updateTaskMeta(7, { title: 'Edited', responsible_id: 8 })).toBe(true)
    expect(port.update).toHaveBeenCalledExactlyOnceWith(7, { title: 'Edited', responsible_id: 8 })
    expect(planning.taskPlanning!.processes![0]!.tasks![0]).toMatchObject({ title: 'Edited', responsible_id: 8 })
  })

  it('preserves filled planning without another snapshot read', async () => {
    planning.taskPlanning = oldPlanning()
    await planning.loadTaskPlanning()
    expect(port.readPlanning).not.toHaveBeenCalled()
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.title).toBe('Old')
  })

  it('keeps a cache miss distinct from a loaded empty hierarchy', async () => {
    port.readPlanning.mockResolvedValueOnce({ status: 'missing' })
    await planning.loadTaskPlanning()
    expect(planning.taskPlanning).toBeNull()
    port.readPlanning.mockResolvedValueOnce({ status: 'ok', data: { processes: [] }, source: 'refresh' })
    await planning.refreshTaskPlanning()
    expect(planning.taskPlanning).toEqual({ processes: [] })
  })

  it('surfaces read refusal without replacing the existing data with an empty result', async () => {
    planning.taskPlanning = oldPlanning()
    port.readPlanning.mockResolvedValueOnce({ status: 'failed', error: failure })
    await planning.refreshTaskPlanning()
    expect(planning.error).toBe(failure.message)
    expect(planning.loading).toBe(false)
    expect(planning.taskPlanning).toEqual(oldPlanning())
  })

  it('leaves visible errors untouched during a silent refresh', async () => {
    planning.error = 'Existing error'
    port.readPlanning.mockResolvedValueOnce({ status: 'failed', error: failure })
    await planning.refreshTaskPlanning(true)
    expect(planning.error).toBe('Existing error')
    expect(planning.loading).toBe(false)
  })

  it('ignores cancellation without reporting an error or clearing data', async () => {
    planning.taskPlanning = oldPlanning()
    port.readPlanning.mockResolvedValueOnce({ status: 'cancelled' })
    await planning.refreshTaskPlanning()
    expect(planning.error).toBeNull()
    expect(planning.taskPlanning).toEqual(oldPlanning())
  })

  it('does not let an older GET replace a newer GET', async () => {
    const old = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot('New'))
    const first = planning.refreshTaskPlanning(true)
    await planning.refreshTaskPlanning(true)
    old.resolve(snapshot('Old'))
    await first
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('New')
  })

  it('ignores an older refusal after a newer read succeeds', async () => {
    const old = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(old.promise).mockResolvedValueOnce(snapshot('New'))
    const first = planning.refreshTaskPlanning()
    await planning.refreshTaskPlanning()
    old.resolve({ status: 'failed', error: failure })
    await first
    expect(planning.error).toBeNull()
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('New')
  })

  it('keeps loading while a newer foreground read is still pending', async () => {
    const first = deferred<ReadResult<DtoTaskPlanning>>()
    const second = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const old = planning.refreshTaskPlanning()
    const fresh = planning.refreshTaskPlanning()
    first.resolve(snapshot('Old'))
    await old
    expect(planning.loading).toBe(true)
    expect(planning.taskPlanning).toBeNull()
    second.resolve(snapshot('Fresh'))
    await fresh
    expect(planning.loading).toBe(false)
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('Fresh')
  })

  it.each(['snapshot', 'refresh'] as const)('ignores %s data after session reset', async (source) => {
    const old = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(old.promise)
    const pending = source === 'snapshot' ? planning.loadTaskPlanning() : planning.refreshTaskPlanning()
    planning.resetUserData()
    old.resolve(snapshot('Previous account'))
    await pending
    expect(planning.taskPlanning).toBeNull()
    expect(planning.error).toBeNull()
  })

  it('does not let a late cached snapshot replace fresh API data', async () => {
    const cached = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(cached.promise).mockResolvedValueOnce(snapshot('Fresh'))
    const pending = planning.loadTaskPlanning()
    await planning.refreshTaskPlanning(true)
    cached.resolve(snapshot('Cached'))
    await pending
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('Fresh')
  })

  it('does not cancel a refresh when a cache load begins later', async () => {
    const fresh = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(fresh.promise).mockResolvedValueOnce(snapshot('Cached'))
    const pending = planning.refreshTaskPlanning(true)
    await planning.loadTaskPlanning()
    fresh.resolve(snapshot('Fresh'))
    await pending
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('Fresh')
  })

  it('keeps queued edits when a stale server snapshot arrives', async () => {
    planning.taskPlanning = oldPlanning()
    pendingRefs.value = new Set(['task:7'])
    await planning.refreshTaskPlanning(true)
    expect(planning.taskPlanning).toEqual(oldPlanning())
  })

  it('ignores a GET begun before a task mutation', async () => {
    planning.taskPlanning = oldPlanning()
    const old = deferred<ReadResult<DtoTaskPlanning>>()
    port.readPlanning.mockReturnValueOnce(old.promise)
    const pending = planning.refreshTaskPlanning(true)
    await planning.updateTaskMeta(7, { title: 'Edited' })
    old.resolve(snapshot('Stale'))
    await pending
    expect(planning.taskPlanning!.processes![0]!.tasks![0]!.title).toBe('Edited')
  })

  it('waits for confirmation before applying task metadata', async () => {
    planning.taskPlanning = oldPlanning()
    const reply = deferred<CommandResult<DtoTaskResponse | null>>()
    port.update.mockReturnValueOnce(reply.promise)
    const pending = planning.updateTaskMeta(7, { title: 'Edited' })
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.title).toBe('Old')
    expect(hasActiveMutations()).toBe(true)
    reply.resolve({ status: 'confirmed', data: { id: 7 } })
    expect(await pending).toBe(true)
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.title).toBe('Edited')
  })

  it('applies a queued task edit with the existing boolean success contract', async () => {
    planning.taskPlanning = oldPlanning()
    port.update.mockResolvedValueOnce({ status: 'queued' })
    expect(await planning.updateTaskMeta(7, { title: 'Local' })).toBe(true)
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.title).toBe('Local')
  })

  it.each(['rejected', 'conflict', 'unknown'] as const)('keeps metadata on %s', async (status) => {
    planning.taskPlanning = oldPlanning()
    port.update.mockResolvedValueOnce({ status, error: failure })
    expect(await planning.updateTaskMeta(7, { title: 'Denied' })).toBe(false)
    expect(planning.taskPlanning).toEqual(oldPlanning())
    expect(planning.error).toBe(failure.message)
  })

  it('keeps immediate drag dates and applies the confirmed canonical dates', async () => {
    planning.taskPlanning = oldPlanning()
    const reply = deferred<CommandResult<DtoTaskResponse | null>>()
    port.update.mockReturnValueOnce(reply.promise)
    const pending = planning.updateTaskDates(7, '2026-11-16', '2026-11-22')
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.start_date).toBe('2026-11-16')
    reply.resolve({ status: 'confirmed', data: { id: 7, start_date: '2026-11-17', end_date: '2026-11-23' } })
    expect(await pending).toBe(true)
    expect(planning.taskPlanning.processes![0]!.tasks![0]).toMatchObject({ start_date: '2026-11-17', end_date: '2026-11-23' })
  })

  it('rolls back only the rejected date proposal', async () => {
    planning.taskPlanning = oldPlanning()
    port.update.mockResolvedValueOnce({ status: 'rejected', error: failure })
    port.readPlanning.mockResolvedValueOnce({ status: 'cancelled' })
    expect(await planning.updateTaskDates(7, '2026-11-16', '2026-11-22')).toBe(false)
    expect(planning.taskPlanning).toEqual(oldPlanning())
  })

  it('does not apply a previous session write to the same task id in a new session', async () => {
    planning.taskPlanning = oldPlanning()
    const reply = deferred<CommandResult<DtoTaskResponse | null>>()
    port.update.mockReturnValueOnce(reply.promise)
    const pending = planning.updateTaskMeta(7, { title: 'Previous user edit' })
    planning.resetUserData()
    planning.taskPlanning = oldPlanning()
    reply.resolve({ status: 'confirmed', data: { id: 7 } })
    expect(await pending).toBe(false)
    expect(planning.taskPlanning).toEqual(oldPlanning())
    expect(planning.error).toBeNull()
  })

  it('updates a subtask through the same port', async () => {
    planning.taskPlanning = { processes: [{ id: 10, tasks: [{ id: 7, subtasks: [{ id: 8, title: 'Subtask' }] }] }] }
    expect(await planning.updateSubtask(8, { title: 'Edited subtask' })).toBe(true)
    expect(port.update).toHaveBeenCalledExactlyOnceWith(8, { title: 'Edited subtask' })
    expect(planning.taskPlanning.processes![0]!.tasks![0]!.subtasks![0]!.title).toBe('Edited subtask')
  })
})
