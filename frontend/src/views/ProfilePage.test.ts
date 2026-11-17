// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createApp, nextTick } from 'vue'
import { AxiosError, CanceledError, type AxiosResponse } from 'axios'
import { isOffline } from '@/store/data/uiServices'
import ProfilePage from './ProfilePage.vue'
import { appLocale, setAppLocale, t } from '@/i18n'

const fake = vi.hoisted(() => ({ info: vi.fn(), profile: vi.fn(), presets: vi.fn() }))
vi.mock('../store', () => ({
  useAuthStore: () => ({ user: { id: 42, username: 'reader' }, fetchProfile: fake.profile }),
  useRbacStore: () => ({ presets: [], ensurePresets: fake.presets }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ query: { section: 'about' } }) }))
vi.mock('@/store/data/uiServices', async () => ({ isOffline: (await import('vue')).ref(false) }))
vi.mock('@/store/data/pageReads', () => ({ loadBackendInfo: fake.info }))
vi.mock('./ProfileEditPage.vue', () => ({ default: { render: () => null } }))

const info = { version: '9.7.3', changelog_ru: '## Backend RU\n\nBackend-only release notes.', changelog_en: '## Backend EN\n\nEnglish backend-only release notes.' }
let unmount = () => {}
let host: HTMLDivElement
async function mount() {
  host = document.createElement('div'); document.body.append(host)
  const app = createApp(ProfilePage)
  app.component('RouterLink', { template: '<a><slot /></a>' })
  app.mount(host); unmount = () => app.unmount()
  await nextTick(); await nextTick()
}
function changelogButton(service: 'frontend' | 'backend') {
  return host.querySelector<HTMLButtonElement>(`button[aria-label="${t(`changelog.${service}Title`)}"]`)!
}
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')

beforeEach(() => {
  vi.clearAllMocks(); setAppLocale('ru'); isOffline.value = false
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  fake.info.mockResolvedValue(info)
})
afterEach(() => { unmount(); document.body.replaceChildren(); setAppLocale('ru'); vi.restoreAllMocks() })

it('shows both service versions without a build version or account ID', async () => {
  await mount()
  const labels = Array.from(host.querySelectorAll('dt'), node => node.textContent)
  expect(labels).toEqual([t('adminUsers.profile.field.state'), t('adminUsers.profile.field.frontendVersion'), t('adminUsers.profile.field.backendVersion')])
  expect(Array.from(host.querySelectorAll('.pf-version'), node => node.textContent)).toEqual(['vitest', '9.7.3'])
  expect(fake.info).toHaveBeenCalledWith(expect.any(AbortSignal))
})

it('opens the matching service notes, switches their language and closes the modal', async () => {
  await mount()
  changelogButton('frontend').click(); await nextTick()
  expect(dialog()?.getAttribute('aria-label')).toBe(t('changelog.frontendTitle'))
  expect(dialog()?.textContent).toContain('vitest')
  expect(dialog()?.querySelector('.mdv')?.textContent).toContain('Changelog')
  expect(dialog()?.textContent).not.toContain('Backend-only')
  document.querySelector<HTMLButtonElement>('.cdlg-close')!.click(); await nextTick()
  expect(dialog()).toBeNull()

  changelogButton('backend').click(); await nextTick()
  expect(dialog()?.getAttribute('aria-label')).toBe(t('changelog.backendTitle'))
  expect(dialog()?.textContent).toContain('9.7.3')
  expect(dialog()?.querySelector('.mdv')?.textContent).toContain('Backend RU')
  expect(dialog()?.textContent).not.toContain('vitest')
  setAppLocale('en'); await nextTick()
  expect(appLocale.value).toBe('en')
  expect(dialog()?.getAttribute('aria-label')).toBe(t('changelog.backendTitle'))
  expect(dialog()?.textContent).toContain('Backend EN')
  expect(dialog()?.textContent).not.toContain('Backend RU')
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await nextTick()
  expect(dialog()).toBeNull()
})

it.each(['unavailable', 'missing', 'version-only'] as const)('keeps frontend notes usable when backend metadata is %s', async state => {
  if (state === 'unavailable') fake.info.mockRejectedValue(new Error('Backend unavailable'))
  else fake.info.mockResolvedValue(state === 'missing' ? null : { version: '9.7.3' })
  await mount()
  expect(changelogButton('backend').disabled).toBe(true)
  changelogButton('backend').click(); await nextTick(); expect(dialog()).toBeNull()
  expect(host.textContent).toContain(state === 'version-only' ? '9.7.3' : '—')
  expect(changelogButton('frontend').disabled).toBe(false)
  changelogButton('frontend').click(); await nextTick(); expect(dialog()).not.toBeNull()
})

it('aborts the metadata read when leaving the page', async () => {
  fake.info.mockImplementation((signal: AbortSignal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new CanceledError()), { once: true })
  }))
  await mount()
  const signal = fake.info.mock.calls[0][0] as AbortSignal
  expect(signal.aborted).toBe(false)
  unmount(); unmount = () => {}
  await nextTick(); await nextTick()
  expect(signal.aborted).toBe(true)
  expect(console.warn).not.toHaveBeenCalled()
})


it.each([
  { status: 500, offline: false, warn: true },
  { status: 404, offline: false, warn: false },
  { status: 503, offline: true, warn: false },
])('reports HTTP $status with offline=$offline without leaking response contents', async ({ status, offline, warn }) => {
  isOffline.value = offline
  const error = new AxiosError('private diagnostic body', 'ERR_BAD_RESPONSE', undefined, undefined, { status, data: { secret: 'never-log-this' } } as AxiosResponse)
  fake.info.mockRejectedValue(error)
  await mount()
  expect(changelogButton('backend').disabled).toBe(true)
  if (warn) expect(console.warn).toHaveBeenCalledExactlyOnceWith('[about] backend-metadata-unavailable', { status, timeout: false })
  else expect(console.warn).not.toHaveBeenCalled()
})

it.each([
  { error: new DOMException('Timed out', 'TimeoutError'), warn: true },
  { error: new CanceledError(), warn: false },
])('distinguishes a metadata deadline from ordinary cancellation: $error.name', async ({ error, warn }) => {
  fake.info.mockRejectedValue(error)
  await mount()
  if (warn) expect(console.warn).toHaveBeenCalledExactlyOnceWith('[about] backend-metadata-unavailable', { status: undefined, timeout: true })
  else expect(console.warn).not.toHaveBeenCalled()
})
