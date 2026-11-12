'use strict'
const electron = require('electron')
const { startDesktop } = require('../../desktop/application.cjs')
const { app } = electron
if (!process.env.ERP_STORAGE_PROFILE || !process.env.ERP_STORAGE_WEB) throw new Error('Isolated storage fixtures are required')
app.setName('clockwork-storage-application-test')
app.setPath('userData', process.env.ERP_STORAGE_PROFILE)
const lifecycle = startDesktop(electron, {
  webDir: process.env.ERP_STORAGE_WEB,
  basePort: Number(process.env.ERP_STORAGE_PORT || 0),
  createPorts: ({ storage }) => ({
    reads: { 'planning.tasks': async (_, options) => {
      const scope = { server: options.scope.server, accountId: options.scope.accountId }
      const snapshot = await storage.forScope(scope).snapshot({ domain: 'planning.tasks' })
      return snapshot ? { status: 'ok', data: snapshot.data, source: 'snapshot' } : { status: 'missing' }
    } },
    commands: { 'task.update': async (input, options) => {
      const scope = { server: options.scope.server, accountId: options.scope.accountId }, repository = storage.forScope(scope)
      const previous = await repository.snapshot({ domain: 'planning.tasks' })
      await repository.commitLocal({ operationId: options.operationId, operation: 'task.update', input, idempotencyKey: options.operationId, changes: [{ domain: 'planning.tasks', key: 'default', expectedRevision: previous?.revision ?? 0, data: { processes: [{ id: 1, tasks: [{ id: input.id, title: input.patch.title }] }] } }] })
      return { status: 'queued' }
    } },
  }),
})
lifecycle.ready.then(controller => {
  if (!controller) return
  controller.service.setScope({ server: 'https://erp.example/api/v1', accountId: 7 })
  globalThis.storageApplication = controller
})
