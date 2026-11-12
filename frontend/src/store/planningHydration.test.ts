import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop', optionalStorage: false } }))
import { createPinia, setActivePinia } from 'pinia'

const fake = vi.hoisted(() => ({ read: vi.fn(), hydrate: vi.fn() }))
vi.mock('@/api', async original => ({
  ...await original<typeof import('@/api')>(),
  PlanningApi: class {
    planningProjectsGet = fake.read
    planningProcessesGet = fake.read
    planningTasksGet = fake.read
  },
}))
vi.mock('@/offline/hydrate', () => ({ apiPath: (path: string) => path, hydrateFromCache: fake.hydrate }))
import { usePlanningStore } from './index'
import { pendingRefs } from '@/offline/outbox'
import { legacyQueueAvailability } from '@/platform/state'

const cases = [
  ['projectPlanning', 'refreshProjectPlanning', '/planning/projects'],
  ['processPlanning', 'refreshProcessPlanning', '/planning/processes'],
  ['taskPlanning', 'refreshTaskPlanning', '/planning/tasks'],
] as const

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  pendingRefs.value = new Set(['task:7'])
  legacyQueueAvailability.value = 'pending'
  fake.read.mockResolvedValue({ data: { data: { server: 'raw snapshot' } } })
})
afterEach(() => { pendingRefs.value = new Set(); legacyQueueAvailability.value = 'empty' })

describe('planning with a durable queue and an empty in-memory snapshot', () => {
  it.each(cases)('hydrates %s through the cache overlay after its GET succeeds', async (field, method, path) => {
    const planning = usePlanningStore()
    const overlaid = { cached: 'snapshot with pending edits replayed' }
    fake.hydrate.mockImplementation(async targets => {
      expect(targets[0].path).toBe(path)
      targets[0].apply({ data: overlaid })
    })

    await planning[method](true)

    expect(fake.read).toHaveBeenCalledTimes(1)
    expect(fake.hydrate).toHaveBeenCalledTimes(1)
    expect(planning[field]).toEqual(overlaid)
  })

  it.each(cases)('preserves an existing optimistic %s without replacing it', async (field, method) => {
    const planning = usePlanningStore()
    planning[field] = {}
    const current = planning[field]

    await planning[method](true)

    expect(planning[field]).toBe(current)
    expect(fake.hydrate).not.toHaveBeenCalled()
  })
})
