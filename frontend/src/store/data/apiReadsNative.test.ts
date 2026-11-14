import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AxiosRequestConfig, AxiosResponse } from 'axios'
vi.mock('@/config', () => ({ getApiUrl: () => 'https://native.example/api/v1' }))
vi.mock('@/i18n', () => ({ currentLocale: () => 'ru', t: (key: string) => key }))
vi.mock('@/offline/cache', () => ({ currentUserId: () => 7 }))
import { invalidateApiReads, readApi } from './apiReads'
const response = (value: string) => ({ data: { data: value, error: {} } }) as AxiosResponse
beforeEach(() => vi.stubGlobal('window', { erpDesktop: { queue: { mainSync: true } } }))
afterEach(() => { invalidateApiReads(); vi.unstubAllGlobals() })
it('reads each committed main snapshot instead of reusing an older renderer response', async () => {
  const send = vi.fn<(request: AxiosRequestConfig) => Promise<AxiosResponse>>()
  send.mockResolvedValueOnce(response('first')).mockResolvedValueOnce(response('second'))
  expect((await readApi('projects', [], send, true)).data.data).toBe('first')
  expect((await readApi('projects', [], send, true)).data.data).toBe('second')
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls.every(([request]) => request.headers?.['X-Desktop-Read-Source'] === 'snapshot')).toBe(true)
})
it('does not join a foreground network read to a concurrent snapshot read', async () => {
  let release!: (value: AxiosResponse) => void
  const foreground = vi.fn(() => new Promise<AxiosResponse>(resolve => { release = resolve }))
  const fresh = readApi('projects', [], foreground, false)
  await vi.waitFor(() => expect(foreground).toHaveBeenCalledOnce())
  const cached = await readApi('projects', [], async () => response('cached'), true)
  expect(cached.data.data).toBe('cached')
  release(response('fresh'))
  expect((await fresh).data.data).toBe('fresh')
})
it('preserves normal web request options', async () => {
  vi.stubGlobal('window', {})
  const send = vi.fn<(request: AxiosRequestConfig) => Promise<AxiosResponse>>(async () => response('web'))
  await readApi('web.projects', [], send, true)
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty('headers')
})
