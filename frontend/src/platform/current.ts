import { shallowRef } from 'vue'
import type { ApplicationRuntime } from './lifecycle'

export const currentRuntime = shallowRef<ApplicationRuntime | null>(null)

export function createRuntimeHost(load: () => Promise<ApplicationRuntime>) {
  let generation = 0
  let flight: Promise<void> | null = null
  let owned: ApplicationRuntime | null = null
  return {
    start() {
      if (flight) return flight
      const own = ++generation
      flight = load().then(runtime => {
        if (own !== generation) { runtime.stop(); return }
        owned = runtime
        currentRuntime.value = runtime
        return runtime.start()
      }).catch(error => {
        if (own === generation) console.error('[boot] platform services failed, UI remains available', error)
      })
      return flight
    },
    stop() {
      generation++
      flight = null
      owned?.stop()
      if (currentRuntime.value === owned) currentRuntime.value = null
      owned = null
    },
  }
}

export async function retryPlatformConnection(): Promise<void> {
  await currentRuntime.value?.retryConnection()
}

export async function waitForPlatform(start: Promise<void>, boundMs: number): Promise<void> {
  if (boundMs <= 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([start, new Promise<void>(resolve => { timer = setTimeout(resolve, boundMs) })])
  } finally { clearTimeout(timer) }
}
