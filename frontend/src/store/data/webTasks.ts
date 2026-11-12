import type { Configuration } from '@/api'
import { PlanningApi, TasksApi, type DtoTaskResponse } from '@/api'
import type { TaskDataPort } from '@/data/contracts'
import { readApi, isReadCancelled } from './apiReads'
import { readConfiguration } from './readConfiguration'
import { createLegacyTaskData } from './legacyTasks'
import { legacyQueueAvailability } from '@/platform/state'
import { legacyFailure } from './legacyErrors'
import { runWebCommand } from './webCommands'

export function createWebTaskData(configuration: () => Configuration): TaskDataPort {
  const legacy = createLegacyTaskData(configuration)
  return {
    async readPlanning(options) {
      if (options.source === 'snapshot' && legacyQueueAvailability.value === 'pending') return legacy.readPlanning(options)
      try {
        const response = await readApi('planning.tasks', undefined,
          request => new PlanningApi(readConfiguration(configuration)).planningTasksGet(request), options.source === 'snapshot', options.signal)
        const data = response.data?.data
        return data == null ? { status: 'missing' } : { status: 'ok', data, source: (response as { __erpLocalSnapshot?: boolean }).__erpLocalSnapshot ? 'snapshot' : 'refresh' }
      } catch (error) {
        return isReadCancelled(error) ? { status: 'cancelled' } : { status: 'failed', error: legacyFailure(error) }
      }
    },
    update(id, patch, options) {
      return runWebCommand<DtoTaskResponse>({
        key: ['task.update', id, patch], entity: 'task', targetId: id, operationId: options?.operationId,
        call: request => new TasksApi(readConfiguration(configuration)).taskIdPut(id, patch, request),
        apply: () => {}, onError: () => {},
      })
    },
  }
}
