import { ref, type Ref } from 'vue'

export type Stop = () => void
export interface RuntimeScope {
  active(): boolean
  onStop(stop: Stop): void
}
export interface ApplicationRuntime {
  kind: 'web' | 'desktop'
  phase: Ref<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>
  start(): Promise<void>
  stop(): void
  retryConnection(): Promise<void>
}

export function createRuntime(
  kind: ApplicationRuntime['kind'],
  initialize: (scope: RuntimeScope) => Promise<void>,
  retryConnection: () => Promise<void>,
): ApplicationRuntime {
  const phase = ref<'idle' | 'starting' | 'running' | 'failed' | 'stopped'>('idle')
  const cleanups: Stop[] = []
  let flight: Promise<void> | null = null
  let stopped = false
  const cleanup = () => {
    for (const stop of cleanups.splice(0).reverse()) {
      try { stop() } catch (error) { console.error('[runtime] cleanup failed', error) }
    }
  }
  const scope: RuntimeScope = {
    active: () => !stopped && phase.value !== 'failed',
    onStop(stop) { if (!scope.active()) stop(); else cleanups.push(stop) },
  }
  return {
    kind, phase,
    start() {
      if (stopped) return Promise.resolve()
      if (flight) return flight
      phase.value = 'starting'
      flight = Promise.resolve().then(() => {
        if (scope.active()) return initialize(scope)
      }).then(() => {
        if (scope.active()) phase.value = 'running'
      }).catch(error => {
        if (!stopped) phase.value = 'failed'
        cleanup()
        throw error
      })
      return flight
    },
    stop() {
      if (stopped) return
      stopped = true
      cleanup()
      phase.value = 'stopped'
    },
    retryConnection: () => scope.active() ? retryConnection() : Promise.resolve(),
  }
}
