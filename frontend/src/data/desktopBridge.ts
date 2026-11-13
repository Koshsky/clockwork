import definitions from '../../desktop/protocol-operations.json'
import type { CommandOperations, CommandPort, CommandResult, DataFailure, ReadOperations, ReadPort, ReadResult, Unsubscribe } from './contracts'

// Check both directions so adding a port operation also requires its IPC schema.
const reads: Record<keyof ReadOperations, boolean> = definitions.read
const commands: Record<keyof CommandOperations, boolean> = definitions.command
export const desktopOperations: { read: Record<keyof typeof definitions.read, boolean>; command: Record<keyof typeof definitions.command, boolean> } = { read: reads, command: commands }

export interface DesktopServiceState {
  protocol: 1
  profileId: string
  instanceId: string
  version: string
  electron: string
  phase: 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'
  revision: number
  context: { id: string; server: string; accountId: number } | null
  storage?: { phase: 'starting' | 'ready' | 'closing' | 'stopped' | 'failed'; driver?: string; sqlite?: string; schemaVersion?: number; journalMode?: string; synchronous?: number; readOnly?: boolean; code?: string }
  queue?: { revision: number; running: boolean; contextId: string; mutationRevision?: number; snapshotRevision?: number; snapshotDomains?: Record<string, number> }
  sync?: { revision: number; contextId: string; running: boolean; reachable: boolean | null; lastPullAt: number | null; progress: number | null; reconnectAt: number | null; code?: string }
  running: number
  capabilities: { reads: Array<keyof ReadOperations>; commands: Array<keyof CommandOperations> }
}
export interface DesktopBridge {
  readonly businessProtocol?: 1
  status(): Promise<DesktopServiceState>
  read<K extends keyof ReadOperations>(request: {
    requestId: string; contextId: string; operation: K
    input: ReadOperations[K]['input']; source: 'snapshot' | 'refresh'; locale?: 'ru' | 'en'
  }): Promise<ReadResult<ReadOperations[K]['output']>>
  execute<K extends keyof CommandOperations>(request: {
    requestId: string; contextId: string; operationId: string; operation: K
    input: CommandOperations[K]['input']; preconditions?: Record<string, string>; temporaryId?: number; locale?: 'ru' | 'en'
  }): Promise<CommandResult<CommandOperations[K]['output'] | null>>
  cancel(requestId: string): Promise<boolean>
  subscribe(listener: (state: DesktopServiceState) => void): Unsubscribe
}
const unavailable = (cause?: unknown): DataFailure => ({ kind: 'unavailable', code: 'DESKTOP_UNAVAILABLE', message: cause instanceof Error ? cause.message : 'DESKTOP_UNAVAILABLE' })

// The protocol marker enables business ports only after main has installed its adapters.
export function createDesktopDataPorts(bridge: DesktopBridge, context: () => DesktopServiceState['context']): { reads: ReadPort; commands: CommandPort } {
  return {
    reads: {
      async read(operation, input, options) {
        const own = context()
        if (options.signal?.aborted) return { status: 'cancelled' }
        if (!own) return { status: 'failed', error: unavailable() }
        const requestId = crypto.randomUUID()
        const abort = () => { void bridge.cancel(requestId).catch(() => {}) }
        options.signal?.addEventListener('abort', abort, { once: true })
        try {
          const result = await bridge.read({ requestId, contextId: own.id, operation, input, source: options.source, ...(options.locale ? { locale: options.locale } : {}) })
          return options.signal?.aborted || context()?.id !== own.id ? { status: 'cancelled' } : result
        } catch (error) {
          return options.signal?.aborted || context()?.id !== own.id ? { status: 'cancelled' } : { status: 'failed', error: unavailable(error) }
        } finally { options.signal?.removeEventListener('abort', abort) }
      },
    },
    commands: {
      async execute(operation, input, options) {
        const own = context(), operationId = options?.operationId ?? crypto.randomUUID()
        if (options?.signal?.aborted) return { status: 'rejected', operationId, error: { kind: 'unavailable', code: 'APPLICATION_CANCELLED', message: 'APPLICATION_CANCELLED' } }
        if (!own) return { status: 'rejected', operationId, error: unavailable() }
        try {
          const result = await bridge.execute({ requestId: crypto.randomUUID(), contextId: own.id, operationId, operation, input, ...(options?.preconditions ? { preconditions: options.preconditions } : {}), ...(options?.temporaryId != null ? { temporaryId: options.temporaryId } : {}), ...(options?.locale ? { locale: options.locale } : {}) })
          return context()?.id !== own.id ? { status: 'unknown', operationId, error: unavailable() } : result
        } catch (error) { return { status: 'unknown', operationId, error: unavailable(error) } }
      },
    },
  }
}
