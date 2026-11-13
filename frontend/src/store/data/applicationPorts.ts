import { desktopSessionState } from '@/session/desktop'
import { desktopDataState, observeDesktopState as adopt } from '@/data/desktopState'
import type { Configuration } from '@/api'
import { createHttpPorts } from './adapters/httpPorts'
import { createDesktopDataPorts } from '@/data/desktopBridge'
import type { CommandPort, ReadPort } from '@/data/contracts'

let ports: { reads: ReadPort; commands: CommandPort } | null = null
let generation = 0
const state = desktopDataState
let pending: Promise<void> | null = null
let unsubscribe: (() => void) | undefined
export function nativeBusinessPorts(): boolean {
  return typeof window !== 'undefined' && window.erpDesktop?.service?.businessProtocol === 1
}
export function applicationPorts(configuration?: () => Configuration, expectedContext = desktopSessionState.value?.contextId): { reads: ReadPort; commands: CommandPort } | Promise<{ reads: ReadPort; commands: CommandPort }> {
  if (!nativeBusinessPorts()) return configuration ? createHttpPorts(configuration) : ports ??= createHttpPorts()
  return nativePorts(expectedContext)
}
async function nativePorts(expectedContext: string | undefined): Promise<{ reads: ReadPort; commands: CommandPort }> {
  const bridge = window.erpDesktop!.service!
  if (!ports) {
    const own = generation
    ports = createDesktopDataPorts(bridge, () => own === generation ? state.value?.context ?? null : null)
    unsubscribe = bridge.subscribe(next => { if (own === generation) adopt(next) })
  }
  const selected = ports, own = generation
  if (!state.value || state.value.queue?.contextId !== expectedContext) {
    pending ??= bridge.status().then(next => { if (own === generation) adopt(next) }).finally(() => { if (own === generation) pending = null })
    await pending
  }
  const valid = () => own === generation && expectedContext != null && desktopSessionState.value?.contextId === expectedContext && state.value?.queue?.contextId === expectedContext
  return {
    reads: { async read(operation, input, options) {
      if (!valid()) return { status: 'cancelled' }
      const result = await selected.reads.read(operation, input, options)
      return valid() ? result : { status: 'cancelled' }
    } },
    commands: { async execute(operation, input, options) {
      const operationId = options?.operationId ?? crypto.randomUUID()
      const changed = () => ({ status: 'unknown' as const, operationId, error: { kind: 'unauthenticated' as const, code: 'DESKTOP_CONTEXT_UNAVAILABLE', message: 'DESKTOP_CONTEXT_UNAVAILABLE' } })
      if (!valid()) return changed()
      const result = await selected.commands.execute(operation, input, { ...options, operationId })
      return valid() ? result : changed()
    } },
  }
}
export function stopApplicationPorts(): void { unsubscribe?.(); unsubscribe = undefined; generation++; ports = null; state.value = null; pending = null }
