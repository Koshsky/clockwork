import { createApplicationServices } from './applicationClients'
import type { Configuration } from '@/api'
import { type DtoTaskResponse } from '@/api'
import type { TaskDataPort } from '@/data/contracts'
import { readApi, isReadCancelled } from './apiReads'
import { readConfiguration } from './readConfiguration'
import { legacyFailure } from './legacyErrors'
import { runWebCommand } from './webCommands'

export function createWebTaskData(configuration: () => Configuration): TaskDataPort {
  const applicationServices = createApplicationServices(configuration, () => readConfiguration(configuration))
  return {
    async readPlanning(options) {
      try {
        const response = await readApi('planning.tasks', undefined,
          request => applicationServices.planning.tasks(request), options.source === 'snapshot', options.signal)
        const data = response.data?.data
        return data == null ? { status: 'missing' } : { status: 'ok', data, source: (response as { __erpLocalSnapshot?: boolean }).__erpLocalSnapshot ? 'snapshot' : 'refresh' }
      } catch (error) {
        return isReadCancelled(error) ? { status: 'cancelled' } : { status: 'failed', error: legacyFailure(error) }
      }
    },
    update(id, patch, options) {
      return runWebCommand<DtoTaskResponse>({
        key: ['task.update', id, patch], entity: 'task', targetId: id, operationId: options?.operationId,
        call: request => applicationServices.tasks.update(id, patch, request),
        apply: () => {}, onError: () => {},
      })
    },
  }
}
