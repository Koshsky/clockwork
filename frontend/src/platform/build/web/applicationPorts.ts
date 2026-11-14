import type { Configuration } from '@/api'
import type { CommandPort, ReadPort } from '@/data/contracts'
import { createHttpPorts } from '@/store/data/adapters/httpPorts'

let ports: { reads: ReadPort; commands: CommandPort } | null = null
export const nativeBusinessPorts = (): boolean => false
export function applicationPorts(configuration?: () => Configuration, _expectedContext?: string): { reads: ReadPort; commands: CommandPort } {
  return configuration ? createHttpPorts(configuration) : ports ??= createHttpPorts()
}
export function stopApplicationPorts(): void { ports = null }
