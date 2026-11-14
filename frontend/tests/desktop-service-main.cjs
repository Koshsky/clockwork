'use strict'

const electron = require('electron')
const { app } = electron
const path = require('node:path')
const { startDesktop } = require('../desktop/application.cjs')
if (!process.env.ERP_SERVICE_TEST_PROFILE || !process.env.ERP_SERVICE_TEST_WEB) throw new Error('An isolated IPC test profile and fixture directory are required')
app.setName('clockwork-ipc-tests')
app.setPath('userData', process.env.ERP_SERVICE_TEST_PROFILE)
const held = new Map(), calls = new Map(), diagnostics = []
app.on('web-contents-created', (_, contents) => {
  for (const name of ['render-process-gone', 'did-finish-load', 'did-fail-load']) contents.on(name, (_, details) => diagnostics.push({ id: contents.id, name, details, url: contents.getURL() }))
})
let secondInstances = 0
app.on('second-instance', () => { secondInstances++ })
const lifecycle = startDesktop({ ...electron, dialog: { showErrorBox: () => console.error('DESKTOP_SERVICE_START_FAILED') } }, {
  webDir: process.env.ERP_SERVICE_TEST_WEB,
  preload: path.join(__dirname, '../desktop/preload.js'),
  basePort: Number(process.env.ERP_SERVICE_TEST_PORT || 0),
  ports: {
    reads: {
      'planning.tasks': () => ({ status: 'ok', data: { processes: [] }, source: 'snapshot' }),
      'resource.list': (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })),
    },
    commands: {
      'task.update': (input, options) => {
        calls.set(options.operationId, (calls.get(options.operationId) || 0) + 1)
        if (input.patch.title === 'hold') return new Promise(resolve => held.set(options.operationId, () => resolve({ status: 'confirmed', data: { id: input.id, title: 'Saved by service' } })))
        return { status: 'confirmed', data: { id: input.id, ...input.patch } }
      },
    },
  },
})
lifecycle.ready.then(controller => {
  if (!controller) return
  controller.service.setScope({ server: 'https://erp.example/api/v1', accountId: 7 })
  globalThis.serviceFixture = {
    ...controller, diagnostics,
    calls: () => Object.fromEntries(calls),
    secondInstances: () => secondInstances,
    release: id => { const resolve = held.get(id); held.delete(id); resolve?.() },
  }
  console.log('DESKTOP_SERVICE_READY')
})
