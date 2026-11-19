// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'
const state = vi.hoisted(() => ({ contextId: 'first' }))
vi.mock('@/session/desktop', () => ({ desktopSessionState: ref(state) }))
import { desktopSessionState } from '@/session/desktop'
import { closeNativeDiagnostics, openNativeDiagnostics, saveNativeDiagnostics, nativeDiagnosticReport, nativeDiagnosticState, nativeDiagnosticsOpen, captureNativeError } from './native'
const report = { schema: 1, platform: 'desktop', frontend_version: '2.2.0', backend_version: 'unknown', state: { mode: 'offline', queue: { pending: 2 } }, records: [] }
const request = vi.fn()
beforeEach(() => {
  closeNativeDiagnostics(); desktopSessionState.value = { ...desktopSessionState.value!, contextId: 'first' }
  Object.defineProperty(window, 'erpDesktop', { value: { diagnostics: { request } }, configurable: true })
  request.mockReset().mockResolvedValue({ contextId: 'first', snapshotId: 'approved-preview', report })
})
afterEach(() => { closeNativeDiagnostics(); Object.defineProperty(window, 'erpDesktop', { value: undefined, configurable: true }) })
it('opens a local preview and saves only its identity, without sending report contents or a path', async () => {
  await openNativeDiagnostics()
  expect(request).toHaveBeenCalledExactlyOnceWith({ action: 'preview', contextId: 'first' })
  expect(nativeDiagnosticReport.value).toEqual(report)
  request.mockResolvedValue({ saved: true }); await saveNativeDiagnostics()
  expect(request).toHaveBeenLastCalledWith({ action: 'save', contextId: 'first', snapshotId: 'approved-preview' })
  expect(nativeDiagnosticState.value).toBe('saved')
})
it.each([true, false])('account change discards a delayed preview/save, saving=%s', async saving => {
  if (saving) await openNativeDiagnostics()
  let resolve!: (value: unknown) => void
  request.mockImplementation(() => new Promise(done => { resolve = done }))
  const pending = saving ? saveNativeDiagnostics() : openNativeDiagnostics()
  desktopSessionState.value = { ...desktopSessionState.value!, contextId: 'second' }
  resolve(saving ? { saved: true } : { contextId: 'first', snapshotId: 'stale', report }); await pending
  expect(nativeDiagnosticsOpen.value).toBe(false); expect(nativeDiagnosticReport.value).toBeNull()
  expect(nativeDiagnosticState.value).toBe('idle')
})
it('cancel leaves a retryable preview; rejection shows a failure and cannot affect business state', async () => {
  await openNativeDiagnostics(); request.mockResolvedValue({ saved: false }); await saveNativeDiagnostics()
  expect(nativeDiagnosticState.value).toBe('idle'); expect(nativeDiagnosticReport.value).toEqual(report)
  request.mockRejectedValue(Error('private raw failure')); await saveNativeDiagnostics()
  expect(nativeDiagnosticState.value).toBe('failed'); expect(nativeDiagnosticReport.value).toEqual(report)
})
it('renderer errors are sanitized before IPC and bridge failure never throws', () => {
  request.mockRejectedValue(Error('offline'))
  captureNativeError('pdf', { message: 'private-name', response: { status: 403, data: { error: { code: 'FORBIDDEN', message: 'secret' } } } })
  expect(JSON.stringify(request.mock.calls)).not.toContain('secret'); expect(JSON.stringify(request.mock.calls)).not.toContain('private-name')
  expect(request.mock.calls[0][0]).toMatchObject({ action: 'record', kind: 'pdf', diagnostic: { status: 403, error_code: 'FORBIDDEN' } })
})
