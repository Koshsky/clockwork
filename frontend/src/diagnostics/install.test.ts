// @vitest-environment jsdom
import { createApp, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { afterEach, expect, it, vi } from 'vitest'
import { installWebDiagnostics } from './install'
import { createWebDiagnosticHistory } from './history'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })
it('captures an actual Vue render error and preserves an existing error handler', () => {
  const history = createWebDiagnosticHistory({ version: '2.2.0', context: () => null })
  const error = new Error('private object')
  const crash = (): never => { throw error }
  const app = createApp({ render: () => h('div', crash()) })
  const previous = vi.fn(); app.config.errorHandler = previous
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  const stop = installWebDiagnostics(app, router, window, history.capture)
  const host = document.createElement('div'); document.body.append(host)
  app.mount(host)
  expect(history.records.value[0]?.kind).toBe('component')
  expect(history.report()).not.toContain('private')
  expect(previous.mock.calls[0]?.[0]).toBe(error)
  app.unmount(); stop(); expect(app.config.errorHandler).toBe(previous)
})
it('records promise, window, chunk and real lazy-route failures without preventing browser defaults', async () => {
  const history = createWebDiagnosticHistory({ version: '2.2.0', context: () => null })
  const app = createApp({ render: () => h('div') })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/broken', component: () => Promise.reject(new Error('private query')) }] })
  const stop = installWebDiagnostics(app, router, window, history.capture)
  try {
    const rejection = new Event('unhandledrejection', { cancelable: true })
    Object.defineProperty(rejection, 'reason', { value: new Error('private token') })
    const chunk = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(rejection)
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('private path') }))
    window.dispatchEvent(chunk)
    await expect(router.push('/broken')).rejects.toThrow('private query')
    expect(history.records.value.map(item => item.kind).sort()).toEqual(['chunk', 'navigation', 'promise', 'window'])
    expect(rejection.defaultPrevented).toBe(false); expect(chunk.defaultPrevented).toBe(false)
    expect(history.report()).not.toContain('private')
  } finally { stop() }
})
it('cleans hooks idempotently and diagnostics failures cannot affect handling', () => {
  const app = createApp({ render: () => h('div') })
  const router = createRouter({ history: createMemoryHistory(), routes: [] })
  const capture = vi.fn(() => { throw new Error('diagnostics failed') })
  const stop = installWebDiagnostics(app, router, window, capture)
  expect(() => window.dispatchEvent(new Event('vite:preloadError'))).not.toThrow()
  expect(capture).toHaveBeenCalledTimes(1)
  stop(); stop()
  window.dispatchEvent(new Event('vite:preloadError'))
  expect(capture).toHaveBeenCalledTimes(1)
})
