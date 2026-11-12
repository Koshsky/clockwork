import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/platform/context', () => ({ platformCapabilities: { kind: 'desktop', optionalStorage: false } }))
import { createPinia, setActivePinia } from 'pinia'
import { useAppStore } from './index'

const mocks = vi.hoisted(() => ({ hydrate: vi.fn(), warm: vi.fn() }))
vi.mock('@/offline/hydrate', () => ({
  hydrateFromCache: mocks.hydrate,
  apiPath: (path: string) => `/api/v1${path}`,
}))
vi.mock('@/offline/warmup', () => ({ scheduleWarmup: mocks.warm }))

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  mocks.hydrate.mockResolvedValue(undefined)
})

describe('person badges on a cold user catalog', () => {
  it('schedules background loading when the cache has no users', async () => {
    await useAppStore().loadUsers()
    expect(mocks.warm).toHaveBeenCalledOnce()
  })

  it('uses cached users without scheduling another pull', async () => {
    mocks.hydrate.mockImplementation(async (targets) => {
      targets[0].apply({ data: [{ id: 2, name: 'Иванов Пётр', last_name: 'Иванов', first_name: 'Пётр' }] })
    })
    const store = useAppStore()
    await store.loadUsers()
    expect(store.users[0]?.last_name).toBe('Иванов')
    expect(mocks.warm).not.toHaveBeenCalled()
  })

  it('keeps an already loaded catalog without more work', async () => {
    const store = useAppStore()
    store.users = [{ id: 2, name: 'Иванов Пётр' }]
    await store.loadUsers()
    expect(mocks.hydrate).not.toHaveBeenCalled()
    expect(mocks.warm).not.toHaveBeenCalled()
  })
})
