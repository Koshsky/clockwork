'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const payload = ['command-periodAvailability.cjs', 'command-calendar.cjs', 'command-date.cjs', 'command-clamp.cjs', 'command-revisions.cjs', 'command-baseline.cjs', 'command-request.cjs', 'command-queue.cjs', 'command-cacheProjection.cjs', 'command-planning.cjs', 'command-timesheet.cjs', 'storage.cjs', 'storage-worker.cjs', 'storage-db.cjs', 'storage-schema.cjs', 'storage-validation.cjs', 'protocol.cjs', 'protocol-operations.json', 'session-service.cjs', 'api-routes.json']
function verifyStoragePayload(source, resources) {
  const directory = path.join(resources, 'app.asar.unpacked')
  for (const name of payload) {
    const target = path.join(directory, name)
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(fs.readFileSync(path.join(source, name)))) throw new Error('Invalid packaged storage payload: ' + name)
  }
}
function verifyStorageRuntime(executable) {
  const result = spawnSync(executable, [__filename, '--child'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30000 })
  if (result.error || result.status !== 0) throw new Error('Desktop SQLite runtime verification failed')
  const info = JSON.parse(result.stdout.trim())
  const expected = require('./package.json').devDependencies.electron
  if (info.electron !== expected || Number(info.node.split('.')[0]) < 24 || info.storage.driver !== 'node:sqlite' || info.storage.journalMode !== 'wal' || info.storage.synchronous !== 2) throw new Error('Unsupported desktop SQLite runtime')
  return info
}
if (require.main === module) {
  if (process.argv[2] === '--child') {
    const promises = require('node:fs/promises')
    const { createStorage } = require('./storage.cjs')
    void (async () => {
      const directory = await promises.mkdtemp(path.join(require('node:os').tmpdir(), 'clockwork-sqlite-smoke-'))
      let store
      try {
        store = await createStorage({ directory })
        const repository = store.forScope({ server: 'https://storage.example', accountId: 1 })
        await repository.saveSetting({ key: 'probe', value: 'ok', expectedRevision: 0 })
        if ((await repository.setting({ key: 'probe' })).value !== 'ok') throw new Error('Storage round trip failed')
        console.log(JSON.stringify({ electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, storage: store.status() }))
      } finally { await store?.close(); await promises.rm(directory, { recursive: true, force: true }) }
    })().catch(() => { process.exitCode = 1 })
  } else if (process.argv[2] === '--payload') verifyStoragePayload(process.argv[3], process.argv[4])
  else console.log(JSON.stringify(verifyStorageRuntime(process.env.ELECTRON_EXECUTABLE || require('electron'))))
}
module.exports = { verifyStoragePayload, verifyStorageRuntime, payload }
