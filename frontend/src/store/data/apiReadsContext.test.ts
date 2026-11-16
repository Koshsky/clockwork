import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AxiosResponse } from 'axios'
import { getApiUrl } from '@/config'
import { setAppLocale } from '@/i18n'
import { ReadCancelled } from '@/data/requestCache'
import { invalidateApiReads, readApi } from './apiReads'

const response = (value: string) => ({ data: { data: value } }) as AxiosResponse
let values: Map<string, string>
beforeEach(() => {
  values = new Map([['mvs_erp_user', JSON.stringify({ id: 1 })]])
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null })
  vi.stubEnv('VITE_API_URL', '/api/v1')
  setAppLocale('ru')
  invalidateApiReads()
})
afterEach(() => { invalidateApiReads(); setAppLocale('ru'); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('API adapter context isolation', () => {
  it.each([
    ['API base configuration', () => vi.stubEnv('VITE_API_URL', '/proxy/api/v1')],
    ['authenticated account', () => values.set('mvs_erp_user', JSON.stringify({ id: 2 }))],
    ['interface language', () => setAppLocale('en')],
  ] as const)('does not reuse cached or pending responses after changing %s', async (_, changeContext) => {
    expect(getApiUrl()).toBe('/api/v1')
    const send = vi.fn(async () => response('previous'))
    await readApi('rows', undefined, send, true)
    let resolve!: (value: AxiosResponse) => void
    const old = readApi('rows', undefined, () => new Promise<AxiosResponse>(done => { resolve = done }))
    const rejected = expect(old).rejects.toBeInstanceOf(ReadCancelled)

    changeContext()
    const current = vi.fn(async () => response('current'))
    expect((await readApi('rows', undefined, current, true)).data.data).toBe('current')
    resolve(response('late previous'))
    await rejected
    expect((await readApi('rows', undefined, current, true)).data.data).toBe('current')
    expect(current).toHaveBeenCalledOnce()
  })
})
