import { beforeEach, expect, it, vi } from 'vitest'
import { createDesktopDataPorts, type DesktopBridge, type DesktopServiceState } from './desktopBridge'
let context: DesktopServiceState['context']
const bridge = {
  status: vi.fn<DesktopBridge['status']>(), read: vi.fn<DesktopBridge['read']>(),
  execute: vi.fn<DesktopBridge['execute']>(), cancel: vi.fn<DesktopBridge['cancel']>(), subscribe: vi.fn<DesktopBridge['subscribe']>(),
}
const ports = createDesktopDataPorts(bridge, () => context)
beforeEach(() => {
  vi.resetAllMocks(); context = { id: 'context', server: 'https://erp.example/api', accountId: 7 }
  bridge.read.mockResolvedValue({ status: 'ok', data: { processes: [] }, source: 'refresh' })
  bridge.execute.mockResolvedValue({ status: 'confirmed', data: { id: 1 } })
  bridge.cancel.mockResolvedValue(true)
})
it('sends a typed read with the service-issued context and snapshot preference', async () => {
  expect((await ports.reads.read('planning.tasks', undefined, { source: 'snapshot' })).status).toBe('ok')
  expect(bridge.read).toHaveBeenCalledWith({ requestId: expect.any(String), contextId: 'context', operation: 'planning.tasks', input: undefined, source: 'snapshot' })
})
it('rejects missing session context without requesting privileged data', async () => {
  context = null
  expect((await ports.reads.read('planning.tasks', undefined, { source: 'refresh' })).status).toBe('failed')
  expect((await ports.commands.execute('task.delete', { id: 1 })).status).toBe('rejected')
  expect(bridge.read).not.toHaveBeenCalled(); expect(bridge.execute).not.toHaveBeenCalled()
})
it('does not send an already cancelled read', async () => {
  const controller = new AbortController(); controller.abort()
  expect((await ports.reads.read('planning.tasks', undefined, { source: 'refresh', signal: controller.signal })).status).toBe('cancelled')
  expect(bridge.read).not.toHaveBeenCalled()
})
it('forwards cancellation by request ID and ignores the late read', async () => {
  const controller = new AbortController()
  let finish!: (result: Awaited<ReturnType<DesktopBridge['read']>>) => void
  bridge.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = ports.reads.read('planning.tasks', undefined, { source: 'refresh', signal: controller.signal })
  controller.abort(); expect(bridge.cancel).toHaveBeenCalledWith(bridge.read.mock.calls[0][0].requestId)
  finish({ status: 'ok', data: { processes: [] }, source: 'refresh' })
  expect((await pending).status).toBe('cancelled')
})
it('rejects a previous account read even if the IPC response arrived successfully', async () => {
  let finish!: (result: Awaited<ReturnType<DesktopBridge['read']>>) => void
  bridge.read.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = ports.reads.read('planning.tasks', undefined, { source: 'refresh' })
  context = { ...context!, id: 'different-account' }; finish({ status: 'ok', data: { processes: [] }, source: 'refresh' })
  expect((await pending).status).toBe('cancelled')
})
it('preserves an operation key and API-level refusal without pretending that it was queued', async () => {
  bridge.execute.mockResolvedValueOnce({ status: 'rejected', error: { kind: 'forbidden', message: 'Forbidden' }, operationId: 'stable-key' })
  const result = await ports.commands.execute('task.update', { id: 1, patch: { title: 'Submitted' } }, { operationId: 'stable-key' })
  expect(result.status).toBe('rejected')
  expect(bridge.execute).toHaveBeenCalledWith({ requestId: expect.any(String), contextId: 'context', operationId: 'stable-key', operation: 'task.update', input: { id: 1, patch: { title: 'Submitted' } } })
})
it('reports an interrupted IPC command as unknown with the same key', async () => {
  bridge.execute.mockRejectedValueOnce(new Error('Connection closed'))
  expect(await ports.commands.execute('task.delete', { id: 1 }, { operationId: 'stable-key' })).toMatchObject({ status: 'unknown', operationId: 'stable-key' })
})
it('does not return a previous account command as current-account success', async () => {
  let finish!: (result: Awaited<ReturnType<DesktopBridge['execute']>>) => void
  bridge.execute.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  const pending = ports.commands.execute('task.delete', { id: 1 }, { operationId: 'stable-key' })
  context = null; finish({ status: 'confirmed', data: null })
  expect(await pending).toMatchObject({ status: 'unknown', operationId: 'stable-key' })
})
it('returns a finite failed read when the main service is unavailable', async () => {
  bridge.read.mockRejectedValueOnce(new Error('Service closed'))
  expect(await ports.reads.read('planning.tasks', undefined, { source: 'refresh' })).toMatchObject({ status: 'failed', error: { kind: 'unavailable' } })
})
