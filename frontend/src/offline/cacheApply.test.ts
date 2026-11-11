/**
 * Pure-logic unit tests for the offline write-through cache overlay
 * (src/offline/cacheApply.ts).
 *
 * The IndexedDB layer is replaced by an in-memory map, so the interesting
 * part — how offline deltas are applied to cached GET responses — is tested
 * directly. Focus: the 86316cc regression, where field lookup helpers
 * (getStateFields / getResourceFields / getUserFields) stopped after the FIRST
 * cached page for a pathname. Lists are cached per page, so the target record
 * may live only in a later page; the helpers must scan ALL pages.
 *
 * Test data uses the exact cache shapes the helpers read:
 *  - /timesheet/states        → bare array          (getStateFields)
 *  - /api/v1/resources        → bare array          (getResourceFields)
 *  - /api/v1/user             → { items, total }    (getUserFields)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxEntry } from './outbox'

const fake = vi.hoisted(() => {
  const cache = new Map<string, unknown>()
  const put = (key: string, value: unknown): void => {
    cache.set(key, value)
  }
  const get = (key: string): unknown => cache.get(key)
  const keys = (): string[] => [...cache.keys()]
  const reset = (): void => cache.clear()
  const find = (pathname: string): Record<string, unknown> | undefined => {
    for (const key of keys()) {
      try {
        if (new URL(key).pathname === pathname) return get(key) as Record<string, unknown>
      } catch {
        if (key.split('?')[0] === pathname) return get(key) as Record<string, unknown>
      }
    }
    return undefined
  }
  return { cache, put, get, keys, reset, find }
})

vi.mock('./db', () => ({
  idbPut: vi.fn(async (_s: string, key: string, value: unknown) => {
    fake.put(key, value)
  }),
  idbGet: vi.fn(async (_s: string, key: string) => fake.get(key)),
  idbKeys: vi.fn(async () => fake.keys()),
}))

import { applyToCache } from './cacheApply'

/** Cached response entry: { ts, data: <backend envelope { data, error }> } */
function env(payload: unknown): { data: unknown; error: unknown } {
  return { data: payload, error: null }
}

/** Wait: entries carry the mutation payload as the backend envelope. */
function entry(over: Partial<OutboxEntry>): OutboxEntry {
  return {
    id: 'e1',
    ts: 1700000000000,
    method: 'POST',
    url: 'http://api.test/api/v1/resource',
    body: undefined,
    entity: 'resource',
    ...over,
  }
}

beforeEach(() => {
  fake.reset()
  vi.clearAllMocks()
})

describe('getStateFields — hydrate across all cached pages (86316cc regression)', () => {
  it('finds the state code/name when the target state is only in the SECOND cached page', async () => {
    fake.put('http://api.test/api/v1/timesheet/states?offset=0', {
      ts: 1,
      // Older page — does not contain the target state id.
      data: env([{ id: 6, code: 'ST6', name: 'Командировка', is_available: false }]),
    })
    fake.put('http://api.test/api/v1/timesheet/states?offset=50', {
      ts: 2,
      // Later page — the target state id lives only here (list was cached per page).
      data: env([{ id: 7, code: 'ST7', name: 'Отпуск', is_available: true }]),
    })
    // An employee days window cached for user 5.
    fake.put('http://api.test/api/v1/user/5/days?start=2025-01-01&end=2025-12-31', {
      ts: 3,
      data: env([{ id: 1, state_id: 6, start_date: '2025-01-01', end_date: '2025-12-31' }]),
    })

    await applyToCache(
      entry({
        entity: 'period',
        method: 'PUT',
        url: 'http://api.test/api/v1/user/5/days?start_date=2025-02-01&end_date=2025-02-28&state_id=7',
        body: { state_id: 7, start_date: '2025-02-01', end_date: '2025-02-28' },
      }),
    )

    const days = fake.find('/api/v1/user/5/days') as {
      data: { data: Array<Record<string, unknown>> }
    }
    const inserted = days.data.data.find((p) => Number(p.id) < 0) as Record<string, unknown>
    // The range [2025-02-01 … 2025-02-28] was cut out of the full-year period
    // and re-inserted with state 7 enriched from the SECOND states page.
    expect(inserted).toBeDefined()
    expect(inserted?.state_id).toBe(7)
    expect(inserted?.state_code).toBe('ST7')
    expect(inserted?.state_name).toBe('Отпуск')
    expect(inserted?.is_available).toBe(true)
    // Tails of the original period are preserved (split semantics).
    expect(days.data.data).toHaveLength(3)
  })

  it('returns no enrichment when the id is absent from every cached page', async () => {
    fake.put('http://api.test/api/v1/timesheet/states?offset=0', {
      ts: 1,
      data: env([{ id: 6, code: 'ST6', name: 'Командировка', is_available: false }]),
    })
    fake.put('http://api.test/api/v1/user/5/days?start=2025-01-01&end=2025-12-31', {
      ts: 3,
      data: env([{ id: 1, state_id: 6, start_date: '2025-01-01', end_date: '2025-12-31' }]),
    })

    await applyToCache(
      entry({
        entity: 'period',
        method: 'PUT',
        url: 'http://api.test/api/v1/user/5/days?start_date=2025-02-01&end_date=2025-02-28&state_id=999',
        body: { state_id: 999, start_date: '2025-02-01', end_date: '2025-02-28' },
      }),
    )

    const days = fake.find('/api/v1/user/5/days') as {
      data: { data: Array<Record<string, unknown>> }
    }
    const inserted = days.data.data.find((p) => Number(p.id) < 0) as Record<string, unknown>
    expect(inserted?.state_code).toBeUndefined()
    // The range split still happened — enrichment failure is not fatal.
    expect(days.data.data).toHaveLength(3)
  })
})

describe('getResourceFields — hydrate across all cached pages (86316cc regression)', () => {
  it('badges the offline assignment with the resource from the SECOND cached page', async () => {
    fake.put('http://api.test/api/v1/resources?limit=50&offset=0', {
      ts: 1,
      data: env([{ id: 1, code: 'R1', title: 'Первый' }, { id: 2, code: 'R2', title: 'Второй' }]),
    })
    fake.put('http://api.test/api/v1/resources?limit=50&offset=50', {
      ts: 2,
      data: env([{ id: 3, code: 'R3', title: 'Третий' }]),
    })
    fake.put('http://api.test/api/v1/planning/tasks', {
      ts: 3,
      data: env({
        processes: [{ id: 10, title: 'Процесс 1', tasks: [{ id: 100, title: 'Задача 1', resources: [] }] }],
      }),
    })

    await applyToCache(
      entry({
        entity: 'assignment',
        method: 'POST',
        url: 'http://api.test/api/v1/assignment',
        body: { task_id: 100, resource_id: 3, quantity: 2 },
        tempId: -123456,
      }),
    )

    const tasks = fake.find('/api/v1/planning/tasks') as {
      data: { data: { processes: Array<{ tasks: Array<{ resources: Array<Record<string, unknown>> }> }> } }
    }
    const resource = tasks.data.data.processes[0].tasks[0].resources[0]
    expect(resource?.assignment_id).toBe(-123456)
    expect(resource?.code).toBe('R3')
    expect(resource?.title).toBe('Третий')
  })
})

describe('getUserFields — hydrate across all cached pages (86316cc regression)', () => {
  it('fills the member fields from the roster page that contains the user (second page)', async () => {
    fake.put('http://api.test/api/v1/user?limit=500&role=admin', {
      ts: 1,
      data: env({ items: [{ id: 1, name: 'A', preset: 'admin' }], total: 2 }),
    })
    fake.put('http://api.test/api/v1/user?limit=500&offset=500&role=admin', {
      ts: 2,
      data: env({
        items: [
          {
            id: 2,
            name: 'Виктор',
            preset: 'manager',
            position: 'Директор',
            manager_id: null,
            hire_date: '2020-01-01',
            termination_date: null,
          },
        ],
        total: 2,
      }),
    })
    fake.put('http://api.test/api/v1/resources/3/members', { ts: 3, data: env([]) })
    fake.put('http://api.test/api/v1/resources?limit=50&offset=0', {
      ts: 3,
      data: env({ items: [{ id: 3, code: 'R3', title: 'Ресурс 3', employees_count: 0 }], total: 1 }),
    })

    await applyToCache(
      entry({
        entity: 'member',
        method: 'POST',
        url: 'http://api.test/api/v1/resources/3/members',
        body: { user_id: 2 },
        tempId: -123456,
      }),
    )

    const members = fake.find('/api/v1/resources/3/members') as {
      data: { data: Array<Record<string, unknown>> }
    }
    expect(members.data.data).toHaveLength(1)
    expect(members.data.data[0]?.id).toBe(2)
    expect(members.data.data[0]?.name).toBe('Виктор')
    expect(members.data.data[0]?.preset).toBe('manager')
    expect(members.data.data[0]?.position).toBe('Директор')
    // The resource member counter on the (first-page) resources list is bumped.
    const resources = fake.find('/api/v1/resources') as {
      data: { data: { items: Array<Record<string, unknown>>; total: number } }
    }
    expect(resources.data.data.items[0]?.employees_count).toBe(1)
  })
})

describe('applyToCache — basic list mutations', () => {
  it('adds a POSTed resource (dedup by id) and bumps the total', async () => {
    fake.put('http://api.test/api/v1/resources?limit=50&offset=0', {
      ts: 1,
      data: env({ items: [{ id: 1, code: 'R1', title: 'Один' }], total: 1 }),
    })

    const mutation = entry({
      entity: 'resource',
      method: 'POST',
      url: 'http://api.test/api/v1/resource',
      body: { code: 'R2', title: 'Два' },
      tempId: -42,
    })
    await applyToCache(mutation)
    await applyToCache(mutation) // idempotent — same temp id must not double-add

    const resources = fake.find('/api/v1/resources') as {
      data: { data: { items: Array<Record<string, unknown>>; total: number } }
    }
    expect(resources.data.data.items).toHaveLength(2)
    expect(resources.data.data.total).toBe(2)
  })

  it('merges a PUT body into the matching item and removes a DELETE by id', async () => {
    fake.put('http://api.test/api/v1/resources?limit=50&offset=0', {
      ts: 1,
      data: env({ items: [{ id: 1, code: 'R1', title: 'Один', employees_count: 0 }], total: 1 }),
    })

    await applyToCache(entry({ entity: 'resource', method: 'PUT', url: 'http://api.test/api/v1/resource/1', body: { title: 'Один обновлён' } }))
    let resources = fake.find('/api/v1/resources') as {
      data: { data: { items: Array<Record<string, unknown>>; total: number } }
    }
    expect(resources.data.data.items[0]?.title).toBe('Один обновлён')

    await applyToCache(entry({ entity: 'resource', method: 'DELETE', url: 'http://api.test/api/v1/resource/1' }))
    resources = fake.find('/api/v1/resources') as {
      data: { data: { items: Array<Record<string, unknown>>; total: number } }
    }
    expect(resources.data.data.items).toHaveLength(0)
    expect(resources.data.data.total).toBe(0)
  })
})

describe('applyToCache — project deletion cascades the planning aggregates', () => {
  it('removes the project group, its processes and their task groups from all cached aggregates', async () => {
    fake.put('http://api.test/api/v1/planning/projects', {
      ts: 1,
      data: env({
        projects: [{ id: 42, project_code: 'P1', priority: 1 }, { id: 99, project_code: 'P2', priority: 2 }],
      }),
    })
    fake.put('http://api.test/api/v1/planning/processes', {
      ts: 2,
      data: env({
        projects: [
          { id: 42, processes: [{ id: 7, project_id: 42 }, { id: 8, project_id: 42 }] },
          { id: 99, processes: [{ id: 9, project_id: 99 }] },
        ],
      }),
    })
    fake.put('http://api.test/api/v1/planning/tasks', {
      ts: 3,
      data: env({
        processes: [
          { id: 7, project_id: 42, tasks: [{ id: 100, title: 'Задача 1' }] },
          { id: 9, project_id: 99, tasks: [{ id: 200, title: 'Задача 2' }] },
        ],
      }),
    })

    await applyToCache(
      entry({
        entity: 'project',
        method: 'DELETE',
        url: 'http://api.test/api/v1/project/42',
      }),
    )

    const projects = fake.find('/api/v1/planning/projects') as {
      data: { data: { projects: Array<Record<string, unknown>> } }
    }
    expect(projects.data.data.projects.map((p) => p.id)).toEqual([99])

    const processes = fake.find('/api/v1/planning/processes') as {
      data: { data: { projects: Array<Record<string, unknown>> } }
    }
    expect(processes.data.data.projects.map((p) => p.id)).toEqual([99])

    const tasks = fake.find('/api/v1/planning/tasks') as {
      data: { data: { processes: Array<Record<string, unknown>> } }
    }
    expect(tasks.data.data.processes.map((p) => p.id)).toEqual([9])
  })
})

describe('complete resource header cache survives offline CRUD', () => {
  const key = 'http://api.test/local/resource-header?owner_id=7'
  it('updates ownership even when the resource is outside the table first page', async () => {
    fake.put(key, { ts: 1, data: [{ id: 501, owner_id: 7 }] })
    await applyToCache(entry({ entity: 'resource', method: 'PUT', url: 'http://api.test/api/v1/resources/501', body: { owner_id: 8 } }))
    expect(fake.get(key)).toMatchObject({ data: [{ id: 501, owner_id: 8 }] })
  })
  it('removes a deleted resource from the complete snapshot', async () => {
    fake.put(key, { ts: 1, data: [{ id: 501, owner_id: 7 }] })
    await applyToCache(entry({ entity: 'resource', method: 'DELETE', url: 'http://api.test/api/v1/resources/501' }))
    expect(fake.get(key)).toMatchObject({ data: [] })
  })
  it('retains a newly created own resource before synchronization', async () => {
    fake.put(key, { ts: 1, data: [] })
    await applyToCache(entry({ entity: 'resource', method: 'POST', url: 'http://api.test/api/v1/resources', tempId: -7, body: { owner_id: 7, code: 'Own', title: 'Own' } }))
    expect(fake.get(key)).toMatchObject({ data: [{ id: -7, owner_id: 7 }] })
  })
})


it.each(['resource', 'process'] as const)('offline %s owner changes clear the corresponding cached assignments', async (entity) => {
  const key = 'http://api.test/api/v1/planning/tasks'
  fake.put(key, { ts: 1, data: env({ processes: [{ id: 1, owner_id: 7, tasks: [{ id: 2, resources: [{ id: 3 }, { id: 4 }] }] }, { id: 5, owner_id: 9, tasks: [{ id: 6, resources: [{ id: 4 }] }] }] }) })
  await applyToCache(entry({ entity, method: 'PUT', url: entity === 'resource' ? 'http://api.test/api/v1/resources/3' : 'http://api.test/api/v1/process/1', body: { owner_id: 8 } }))
  const cached = fake.get(key) as { data: { data: { processes: Array<{ tasks: Array<{ resources: Array<{ id: number }> }> }> } } }
  expect(cached.data.data.processes[0].tasks[0].resources).toEqual(entity === 'resource' ? [{ id: 4 }] : [])
  expect(cached.data.data.processes[1].tasks[0].resources).toEqual([{ id: 4 }])
})


it('updates only the current account prefixed resource header cache', async () => {
  vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ id: 7 }) })
  try {
    const own = 'u7:http://api.test/local/resource-header?owner_id=7'
    const foreign = 'u8:http://api.test/local/resource-header?owner_id=8'
    fake.put(own, { ts: 1, data: [{ id: 1, owner_id: 7 }] })
    fake.put(foreign, { ts: 1, data: [{ id: 1, owner_id: 7 }] })
    await applyToCache(entry({ entity: 'resource', method: 'PUT', url: 'http://api.test/api/v1/resources/1', body: { owner_id: 8 } }))
    expect(fake.get(own)).toMatchObject({ data: [{ id: 1, owner_id: 8 }] })
    expect(fake.get(foreign)).toMatchObject({ data: [{ id: 1, owner_id: 7 }] })
  } finally { vi.unstubAllGlobals() }
})
