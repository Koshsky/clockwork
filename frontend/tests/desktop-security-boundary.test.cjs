'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { isWebUrl, isApplicationDocument } = require('../desktop/security.cjs')
const { createDesktopIpc, REQUEST } = require('../desktop/ipc.cjs')
const { attachRendererRecovery } = require('../desktop/renderer-recovery.cjs')
const { validate } = require('../desktop/protocol.cjs')
const origin = 'http://127.0.0.1:31880'
const badDocuments = ['blob:' + origin + '/document', 'filesystem:' + origin + '/temporary/file', 'data:text/html,attack', 'file:///private/profile', 'javascript:attack()', 'about:blank', 'http://user:password@127.0.0.1:31880/', 'http://127.0.0.1:31881/']
test('only actual credential-free HTTP(S) application documents can own native capabilities', () => {
  for (const url of [origin, origin + '/planner?unit=week#task']) assert.equal(isApplicationDocument(url, origin), true)
  for (const url of badDocuments) assert.equal(isApplicationDocument(url, origin), false, url)
  for (const url of ['https://example.test/help', 'http://localhost:8080']) assert.equal(isWebUrl(url), true)
  for (const url of ['https://user:password@example.test', 'mailto:user@example.test', ...badDocuments.slice(0, 6)]) assert.equal(isWebUrl(url), false)
})
function fixture() {
  const handlers = new Map(), contents = new EventEmitter(), invoke = []
  Object.assign(contents, { id: 1, mainFrame: { url: origin }, isDestroyed: () => false, send() {} })
  const service = { subscribe: () => () => {}, status: () => ({ version: 'fixture', revision: 1 }), detach() {}, read: () => { invoke.push('read'); return {} }, execute: () => { invoke.push('command'); return {} } }
  const session = { subscribe: () => () => {}, detach() {}, status: () => { invoke.push('session'); return {} } }
  const queue = { status: () => ({ contextId: 'context' }), control: () => { invoke.push('queue'); return [] } }
  const host = createDesktopIpc({ ipcMain: { handle: (name, handler) => handlers.set(name, handler), removeHandler: name => handlers.delete(name) }, service, session, queue, origin })
  host.attach(contents)
  return { host, contents, handlers, invoke, event: { sender: contents, senderFrame: contents.mainFrame } }
}
test('blob and filesystem documents cannot use service, session, queue or version IPC', async t => {
  const f = fixture(); t.after(() => f.host.dispose())
  for (const url of badDocuments) {
    f.contents.mainFrame.url = url
    assert.equal((await f.handlers.get(REQUEST)(f.event, { protocol: 1, kind: 'status' })).error.code, 'DESKTOP_UNTRUSTED_SENDER', url)
    assert.equal((await f.handlers.get('erp:session')(f.event, { action: 'status' })).error, 'DESKTOP_UNTRUSTED_SENDER', url)
    assert.equal((await f.handlers.get('erp:queue')(f.event, { action: 'list', contextId: 'context' })).error, 'DESKTOP_UNTRUSTED_SENDER', url)
    assert.throws(() => f.handlers.get('erp:app-version')(f.event), /DESKTOP_UNTRUSTED_SENDER/)
  }
  assert.deepEqual(f.invoke, [])
})
test('renderer crash recovery never reloads a derived-origin or credential-bearing document', async () => {
  for (const url of badDocuments) {
    const contents = new EventEmitter(), loaded = []
    Object.assign(contents, { isDestroyed: () => false, getURL: () => url, loadURL: async next => loaded.push(next) })
    const stop = attachRendererRecovery(contents, { origin, active: () => true, onFailed: () => assert.fail('Unexpected recovery failure') })
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(loaded, [origin], url); stop()
  }
})
for (const entity of ['project', 'process', 'task']) for (const action of ['create', 'update']) {
  test(`${entity}.${action} preserves the clear-responsible sentinel without relaxing owner or ID validation`, () => {
    const fields = { [entity === 'project' ? 'code' : 'title']: 'Edited', color: undefined, owner_id: 1 }
    const request = patch => ({ protocol: 1, kind: 'command', requestId: 'request', contextId: 'context', operationId: 'operation', operation: `${entity}.${action}`, input: action === 'create' ? patch : { id: 1, patch } })
    for (const responsible_id of [undefined, null, 0, 1, Number.MAX_SAFE_INTEGER]) {
      assert.equal(validate(request({ ...fields, responsible_id })), true, String(responsible_id))
    }
    assert.equal(validate(request(fields)), true)
    for (const responsible_id of [-1, 0.5, '0', '1', false, {}, [], NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(validate(request({ ...fields, responsible_id })), false, String(responsible_id))
    }
    for (const owner_id of [0, -1, null, 0.5, '1', false, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(validate(request({ ...fields, owner_id, responsible_id: 0 })), false, String(owner_id))
    }
  })
}
