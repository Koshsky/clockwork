import { expect, it } from 'vitest'
import { Configuration } from '@/api'
import { businessBindings, businessRequest } from './businessRequest'
import { readSenders, commandSenders } from '@/store/data/adapters/httpSenders'
import type { AxiosRequestConfig, InternalAxiosRequestConfig } from 'axios'

const input = {
  id: 17, userId: 23, resourceId: 29, taskId: 31, projectId: 37, processId: 41,
  limit: 50, offset: 100, ownerId: 43, managerId: 47, includeHash: false,
  employeeIds: [53, 59], start: '2026-11-01', end: '2026-11-30', stateId: 61,
  search: 'Fixture & filter', preset: 'vp', tag: 'fixture-role', user: 'Fixture',
  entity: 'task', action: 'update', status: 'success', from: '2026-11-01', to: '2026-11-30', ip: '127.0.0.1',
  patch: { title: 'Changed', responsible_id: null }, ids: [67, 71],
  dependency: { depends_on_task_id: 73, type: 'fs' }, comment: { content: '<text>', parent_id: 79 },
  permissions: { overrides: [{ resource: 'task', action: 'view', granted: false }] },
  resource: 'project', scope: 'all', title: 'Fixture', name: 'Fixture', enabled: false,
}
it('keeps every native business request wire-compatible with the generated HTTP client', async () => {
  for (const binding of businessBindings) {
    let request: AxiosRequestConfig | undefined
    const configuration = new Configuration({ basePath: 'https://fixture.test/api/v1', baseOptions: {
      adapter: async (config: InternalAxiosRequestConfig) => { request = config; return { data: { data: {} }, status: 200, statusText: 'OK', headers: {}, config } },
    } })
    const senders = binding.kind === 'read' ? readSenders : commandSenders
    const send = senders[binding.operation as keyof typeof senders] as (input: never, options: AxiosRequestConfig, config: Configuration) => Promise<unknown>
    await send(input as never, {}, configuration)
    const native = businessRequest(binding.operation, input)
    const [method, template] = native.route.split(' ')
    const pathname = template.replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(native.path[key]))
    const actual = new URL(request!.url!, 'https://fixture.test')
    expect(request!.method?.toUpperCase(), binding.operation).toBe(method)
    expect(actual.pathname, binding.operation).toBe('/api/v1' + pathname)
    expect(Object.fromEntries(actual.searchParams), binding.operation).toEqual(native.query)
    expect(request!.data ? JSON.parse(request!.data as string) : undefined, binding.operation).toEqual(native.body ? JSON.parse(JSON.stringify(native.body)) : undefined)
  }
})
it('preserves null patches, omits optional manager values and encodes list queries once', () => {
  expect(businessRequest('account.setManager', { id: 1, managerId: null }).body).toEqual({})
  expect(businessRequest('task.update', { id: -1, patch: { responsible_id: null } }).body).toEqual({ responsible_id: null })
  expect(businessRequest('timesheet.periods', { employeeIds: [1, 2], start: '2026-11-01', end: '2026-11-30' }).query.ids).toBe('1,2')
  expect(() => businessRequest('fetch', {})).toThrow('APPLICATION_OPERATION_UNAVAILABLE')
})
