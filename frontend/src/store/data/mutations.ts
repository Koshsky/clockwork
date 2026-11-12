import type { AxiosRequestConfig } from 'axios'
import { platformCapabilities } from '@/platform/context'
import { runLegacyMutation, type LegacyMutationOptions } from './legacyMutation'
import { runWebCommand } from './webCommands'
import type { WebCommandOptions } from './webCommands'
import type { CommandResult } from '@/data/contracts'
import { beginMutation } from '@/offline/mutationGuard'
import { commandData, legacyFailure } from './legacyErrors'

export interface MutationOptions<T = unknown> extends Omit<LegacyMutationOptions<T>, 'call'> {
  key: unknown
  targetId?: number
  target?: unknown
  onConfirmed?: () => void
  call: (options?: AxiosRequestConfig) => Promise<unknown>
}
export async function runOnlineCommand<T>(options: WebCommandOptions<T>): Promise<CommandResult<T | null>> {
  if (platformCapabilities.kind === 'web') return runWebCommand(options)
  const finish = options.entity ? beginMutation() : () => {}
  try {
    const response = await options.call({})
    const data = commandData<T>(response)
    finish()
    await options.apply(data)
    options.onConfirmed?.()
    return { status: 'confirmed', data }
  } catch (cause) {
    const error = legacyFailure(cause)
    options.onError(error.message)
    return { status: error.kind === 'unavailable' ? 'unknown' : error.kind === 'conflict' ? 'conflict' : 'rejected', error }
  } finally { finish() }
}
export async function runMutation<T>(options: MutationOptions<T>): Promise<boolean> {
  const result = platformCapabilities.kind === 'web'
    ? await runWebCommand({ ...options, targetId: options.targetId ?? options.tempId })
    : await runLegacyMutation({ ...options, call: () => options.call() })
  return result.status === 'confirmed' || result.status === 'queued'
}
