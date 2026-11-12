'use strict'
const { openStorage } = require('../../desktop/storage-db.cjs')
const { directory, phase, label = 'local' } = JSON.parse(process.argv[2])
const gate = new Int32Array(new SharedArrayBuffer(4))
openStorage(directory, { onCommit(at, operation) {
  if (at === phase && operation === label) {
    process.send({ phase: at })
    Atomics.wait(gate, 0, 0)
  }
} }).then(async store => {
  const scope = { server: 'https://erp.example/api/v1', accountId: 7 }
  store.commitLocal(scope, { operationId: 'crash-intent', idempotencyKey: 'crash-key', operation: 'task.update', input: { id: 1, patch: { title: 'Committed' } }, changes: [{ domain: 'planning.tasks', key: 'default', data: { title: 'Committed' }, expectedRevision: 0 }] })
  store.close()
  process.exit(2)
}).catch(() => process.exit(3))
