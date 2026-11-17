import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AxiosHeaders, type AxiosResponse } from 'axios'
import { loadBackendInfo } from './pageReads'
import { invalidateApiReads, isReadCancelled, readPending } from './apiReads'

const fake = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('./applicationClients', () => ({ createApplicationServices: () => ({ application: { info: fake.info } }) }))
vi.mock('./readConfiguration', () => ({ readConfiguration: vi.fn() }))
vi.mock('@/session/desktop', () => ({ desktopSession: null, prepareDesktopSession: vi.fn() }))
vi.mock('@/offline/state', async () => ({ isOffline: (await import('vue')).ref(false) }))
vi.mock('@/config', () => ({ getApiUrl: () => '/api/v1' }))
vi.mock('@/offline/cache', () => ({ currentUserId: () => 42 }))
vi.mock('@/offline/mutationGuard', () => ({ readStamp: () => 0, mayApplyRead: () => true }))

beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); invalidateApiReads() })
afterEach(() => { invalidateApiReads(); vi.useRealTimers() })

it('bounds an unresponsive metadata bridge and cancels its underlying read', async () => {
  fake.info.mockImplementation(() => new Promise(() => {}))
  const read = loadBackendInfo()
  const result = expect(read).rejects.toMatchObject({ name: 'TimeoutError' })
  const signal = fake.info.mock.calls[0][0].signal as AbortSignal
  await vi.advanceTimersByTimeAsync(9999)
  expect(signal.aborted).toBe(false)
  expect(readPending('application.info')).toBe(true)
  await vi.advanceTimersByTimeAsync(1)
  await result
  expect(signal.aborted).toBe(true)
  expect(readPending('application.info')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('preserves caller cancellation and releases the deadline timer', async () => {
  fake.info.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const result = loadBackendInfo(controller.signal).catch(error => error)
  controller.abort()
  expect(isReadCancelled(await result)).toBe(true)
  expect(fake.info.mock.calls[0][0].signal.aborted).toBe(true)
  expect(readPending('application.info')).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('returns successful metadata and clears its timer without changing service errors', async () => {
  const metadata = { version: '9.7.3', changelog_ru: 'Backend RU', changelog_en: 'Backend EN' }
  fake.info.mockResolvedValue({ data: { data: metadata, error: {} }, status: 200, headers: new AxiosHeaders(), config: { headers: new AxiosHeaders() } } as AxiosResponse)
  expect(await loadBackendInfo()).toEqual(metadata)
  expect(vi.getTimerCount()).toBe(0)
  const failure = new Error('Service unavailable')
  fake.info.mockRejectedValue(failure)
  await expect(loadBackendInfo()).rejects.toBe(failure)
  expect(vi.getTimerCount()).toBe(0)
})
