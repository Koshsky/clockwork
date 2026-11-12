import axios from 'axios'
import { PlanningApi, TasksApi, type Configuration, type DtoTaskPlanning, type DtoTaskResponse } from '@/api'
import type { TaskDataPort } from '@/data/contracts'
import { hydrateFromCache, apiPath } from '@/offline/hydrate'
import { LegacyDomainError, legacyFailure } from './legacyErrors'
import { runLegacyMutation } from './legacyMutation'

export function createLegacyTaskData(configuration: () => Configuration): TaskDataPort {
  return {
    async readPlanning(options) {
      if (options.signal?.aborted) return { status: 'cancelled' }
      try {
        let data: DtoTaskPlanning | null = null
        let source = options.source
        if (options.source === 'snapshot') {
          await hydrateFromCache([{
            path: apiPath('/planning/tasks'),
            filled: () => false,
            apply: (body) => { data = (body as { data?: DtoTaskPlanning } | undefined)?.data ?? null },
          }])
        } else {
          const client = new PlanningApi(configuration())
          const resp = options.signal
            ? await client.planningTasksGet({ signal: options.signal })
            : await client.planningTasksGet()
          const body = resp.data
          const error = body?.error as { code?: unknown; message?: string } | undefined
          if (error && (error.code != null || error.message)) throw new LegacyDomainError(error)
          data = body?.data ?? null
          if ((resp as { __erpLocalSnapshot?: boolean }).__erpLocalSnapshot) source = 'snapshot'
        }
        if (options.signal?.aborted) return { status: 'cancelled' }
        return data == null ? { status: 'missing' } : { status: 'ok', data, source }
      } catch (error) {
        if (options.signal?.aborted || axios.isCancel(error)) return { status: 'cancelled' }
        return { status: 'failed', error: legacyFailure(error) }
      }
    },
    update(id, patch, options) {
      return runLegacyMutation<DtoTaskResponse>({
        entity: 'task',
        operationId: options?.operationId,
        call: () => {
          const client = new TasksApi(configuration())
          return options?.operationId
            ? client.taskIdPut(id, patch, { headers: { 'Idempotency-Key': options.operationId } })
            : client.taskIdPut(id, patch)
        },
        apply: () => {},
        optimistic: () => {},
        onError: () => {},
      })
    },
  }
}
