'use strict'

const { parentPort, workerData } = require('node:worker_threads')
const { openStorage } = require('./storage-db.cjs')
const { storageFailure, requireValue } = require('./storage-validation.cjs')
const { bounded } = require('./protocol.cjs')
const methods = ['snapshot', 'saveSnapshot', 'commitLocal', 'queue', 'receipt', 'markAttempt', 'settle', 'resolveId', 'setting', 'saveSetting', 'commitHttp', 'httpIntent', 'httpHistory', 'cacheRead', 'cacheKeys', 'cacheCommit', 'freezeHttp', 'deferHttp', 'retryHttp', 'discardHttp']
let tail = Promise.resolve()
openStorage(workerData.directory, { readOnly: workerData.readOnly === true }).then(store => {
  parentPort.postMessage({ kind: 'ready', info: store.info() })
  parentPort.on('message', message => {
    tail = tail.then(async () => {
      try {
        requireValue(bounded(message, 16 * 1024 * 1024) && message && Number.isSafeInteger(message.id) && ['info', 'backup', 'close', ...methods].includes(message.method))
        let value
        if (message.method === 'close') { store.close(); value = null }
        else if (message.method === 'info' || message.method === 'backup') value = await store[message.method]()
        else value = await store[message.method](message.scope, message.params)
        requireValue(bounded(value, 16 * 1024 * 1024), 'STORAGE_RESULT_LIMIT')
        parentPort.postMessage({ kind: 'result', id: message.id, ok: true, value })
        if (message.method === 'close') parentPort.close()
      } catch (error) { parentPort.postMessage({ kind: 'result', id: message?.id, ok: false, code: storageFailure(error) }) }
    })
  })
}, error => { parentPort.postMessage({ kind: 'failed', code: storageFailure(error) }); parentPort.close() })
