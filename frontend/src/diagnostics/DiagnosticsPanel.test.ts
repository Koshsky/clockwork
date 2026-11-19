// @vitest-environment jsdom
import { createApp, nextTick } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ epoch: 'one', kind: 'web' }))
vi.mock('@/sessionSync', () => ({ sessionEpoch: () => fake.epoch }))
vi.mock('@/platform/context', () => ({ platformCapabilities: { get kind() { return fake.kind } } }))
import DiagnosticsPanel from './DiagnosticsPanel.vue'
import { diagnosticsOpen, openDiagnostics, resetWebDiagnostics, reportWebError, webDiagnostics } from './web'
import { setAppLocale, t } from '@/i18n'
let unmount = () => {}
const button = (key: string) => Array.from(document.querySelectorAll('button')).find(node => node.textContent?.trim() === t(key))!
const preview = () => document.querySelector<HTMLTextAreaElement>('textarea')!
beforeEach(async () => {
  fake.epoch = 'one'; fake.kind = 'web'; setAppLocale('ru'); resetWebDiagnostics()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } })
  const host = document.createElement('div'); document.body.append(host)
  const app = createApp(DiagnosticsPanel); app.mount(host); unmount = () => app.unmount()
  openDiagnostics(); await nextTick()
})
afterEach(() => { unmount(); resetWebDiagnostics(); document.body.replaceChildren(); vi.restoreAllMocks(); setAppLocale('ru') })
it('previews empty history, both versions and localization without copying on open', async () => {
  expect(document.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe(t('diagnostics.title'))
  expect(document.body.textContent).toContain(t('diagnostics.empty'))
  webDiagnostics.rememberBackendVersion('1.6.0'); await nextTick()
  expect(preview().value).toContain('1.6.0')
  expect(navigator.clipboard.writeText).not.toHaveBeenCalled()
  setAppLocale('en'); await nextTick()
  expect(document.querySelector('[role=dialog]')?.getAttribute('aria-label')).toBe('Diagnostics')
})
it('copies only the preview after an explicit click and clears the local history', async () => {
  reportWebError('api', { response: { status: 500 } }, 'a'.repeat(32)); await nextTick()
  const report = preview().value
  button('diagnostics.copy').click(); await nextTick(); await nextTick()
  expect(navigator.clipboard.writeText).toHaveBeenCalledExactlyOnceWith(report)
  expect(document.body.textContent).toContain(t('diagnostics.copied'))
  button('diagnostics.clear').click(); await nextTick()
  expect(JSON.parse(preview().value).records).toEqual([])
})
it('keeps the report selectable when clipboard permission is denied', async () => {
  vi.mocked(navigator.clipboard.writeText).mockRejectedValue(new Error('private browser error'))
  button('diagnostics.copy').click(); await nextTick(); await nextTick()
  expect(document.body.textContent).toContain(t('diagnostics.copyFailed'))
  expect(preview().readOnly).toBe(true)
  expect(document.body.textContent).not.toContain('private browser error')
})
it('cannot expose a previous session via a pending copy result or reopen', async () => {
  let finish!: () => void
  vi.mocked(navigator.clipboard.writeText).mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  reportWebError('pdf'); await nextTick(); button('diagnostics.copy').click()
  fake.epoch = 'two'; resetWebDiagnostics(); finish(); await nextTick(); await nextTick()
  expect(document.querySelector('[role=dialog]')).toBeNull()
  openDiagnostics(); await nextTick()
  expect(JSON.parse(preview().value).records).toEqual([])
  expect(document.body.textContent).not.toContain(t('diagnostics.copied'))
})
it('closes with Escape and adds no web reporter behavior to desktop', async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(diagnosticsOpen.value).toBe(false)
  fake.kind = 'desktop'
  reportWebError('pdf'); openDiagnostics(); await nextTick()
  expect(webDiagnostics.records.value).toHaveLength(0)
  expect(document.querySelector('[role=dialog]')).toBeNull()
})
