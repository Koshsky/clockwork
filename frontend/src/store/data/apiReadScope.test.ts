import { effectScope, nextTick, watchEffect } from 'vue'
import { expect, it, vi } from 'vitest'
vi.mock('@/config', () => ({ getApiUrl: () => 'http://127.0.0.1:18899/api/v1' }))
vi.mock('@/offline/cache', () => ({ currentUserId: () => 7 }))
import { apiReadScope, invalidateApiReads } from './apiReads'

it('notifies reactive consumers when permissions reset while the server and account stay unchanged', async () => {
  const scope = effectScope(), seen: string[] = []
  scope.run(() => watchEffect(() => { seen.push(apiReadScope()) }))
  try {
    invalidateApiReads()
    await nextTick()
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
    expect(JSON.parse(seen[0]!).slice(0, 3)).toEqual(JSON.parse(seen[1]!).slice(0, 3))
  } finally { scope.stop() }
})
