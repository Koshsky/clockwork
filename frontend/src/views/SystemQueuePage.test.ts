// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import SystemQueuePage from './SystemQueuePage.vue'
import { legacyQueueAvailability } from '@/platform/state'
import { t } from '@/i18n'

const fake = vi.hoisted(() => ({ refresh: vi.fn(), failed: vi.fn(), retry: vi.fn(), discard: vi.fn() }))
vi.mock('@/store/data/uiServices', async () => {
  const { ref } = await import('vue')
  return {
    queueItems: ref([]), isOffline: ref(false), syncNotice: ref(null), dismissSyncNotice: vi.fn(),
    refreshPendingCount: fake.refresh, getFailedEntries: fake.failed, retryFailed: fake.retry, discardFailed: fake.discard,
    queueService: { native: false },
  }
})
vi.mock('../components/common', () => ({ ConfirmDialog: { render: () => null } }))
vi.mock('../notify/state', () => ({ notifyError: vi.fn(), notifySuccess: vi.fn() }))
let unmount = () => {}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  fake.refresh.mockResolvedValue(undefined)
  fake.failed.mockResolvedValue([{ method: 'PUT', url: '/task/1', message: 'Rejected' }])
  fake.retry.mockResolvedValue(undefined); fake.discard.mockResolvedValue(undefined)
})
afterEach(() => { unmount(); document.body.replaceChildren(); vi.useRealTimers() })

it.each(['unknown', 'unavailable', 'empty', 'pending'] as const)('renders %s storage honestly and permits controls only when the queue is known', async state => {
  legacyQueueAvailability.value = state
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp(SystemQueuePage); app.mount(host); unmount = () => app.unmount()
  await vi.advanceTimersByTimeAsync(0)
  const known = state === 'empty' || state === 'pending'
  expect(Array.from(host.querySelectorAll('.sq-card-title'), node => node.textContent).includes(t('adminSystem.queue.empty.title'))).toBe(known)
  expect(host.querySelector('[role="status"]') !== null).toBe(!known)
  expect(host.querySelectorAll('button')).toHaveLength(known ? 2 : 0)
  if (!known) return
  let finish!: () => void
  fake.retry.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const buttons = Array.from(host.querySelectorAll('button'))
  buttons[0].click(); await nextTick()
  expect(buttons.every(button => button.disabled)).toBe(true)
  buttons[1].click()
  expect(fake.retry).toHaveBeenCalledOnce(); expect(fake.discard).not.toHaveBeenCalled()
  finish(); await vi.advanceTimersByTimeAsync(0)
  expect(buttons.every(button => !button.disabled)).toBe(true)
  legacyQueueAvailability.value = 'unavailable'; await nextTick()
  expect(host.querySelectorAll('button')).toHaveLength(0)
  expect(Array.from(host.querySelectorAll('.sq-card-title'), node => node.textContent)).not.toContain(t('adminSystem.queue.empty.title'))
})
