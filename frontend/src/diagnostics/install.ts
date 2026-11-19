import type { App } from 'vue'
import type { Router } from 'vue-router'
import { diagnosticEvent } from '@/domain/diagnostics'
import type { WebDiagnosticKind } from './history'

/** Passive hooks: do not prevent default browser handling, navigate or retry. */
export function installWebDiagnostics(app: App, router: Router, target: Window,
  capture: (kind: WebDiagnosticKind, error?: unknown) => void) {
  const previous = app.config.errorHandler
  const safe = (kind: WebDiagnosticKind, error?: unknown) => { try { capture(kind, error) } catch { /* Best effort. */ } }
  const handler: NonNullable<App['config']['errorHandler']> = (error, instance, info) => {
    safe('component', error)
    if (previous) previous(error, instance, info)
    else console.error('[web]', diagnosticEvent('diagnostic', error, { platform: 'web' }))
  }
  app.config.errorHandler = handler
  const onError = (event: ErrorEvent) => { if (event instanceof ErrorEvent) safe('window', event.error) }
  const onRejection = (event: PromiseRejectionEvent) => safe('promise', event.reason)
  const onChunk = () => safe('chunk')
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  target.addEventListener('vite:preloadError', onChunk)
  const stopRouter = router.onError(error => safe('navigation', error))
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    if (app.config.errorHandler === handler) app.config.errorHandler = previous
    stopRouter()
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
    target.removeEventListener('vite:preloadError', onChunk)
  }
}
