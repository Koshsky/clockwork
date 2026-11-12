'use strict'
const { app } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { createStorage } = require('./storage.cjs')
if (!process.env.ERP_SQLITE_TEST_PROFILE) throw new Error('An isolated profile is required')
app.setName('clockwork-storage-packaging-test')
app.setPath('userData', process.env.ERP_SQLITE_TEST_PROFILE)
app.whenReady().then(async () => {
  let store
  try {
    store = await createStorage({ directory: app.getPath('userData') })
    const repository = store.forScope({ server: 'https://storage.example/api/v1', accountId: 7 })
    await repository.commitLocal({ operationId: 'packaged', idempotencyKey: 'packaged-key', operation: 'task.update', input: { id: 1, patch: { title: 'Packaged' } }, changes: [{ domain: 'planning.tasks', key: 'default', expectedRevision: 0, data: { title: 'Packaged' } }] })
    const result = { ok: true, version: app.getVersion(), archive: app.getAppPath().endsWith('app.asar'), storage: store.status(), rows: await repository.queue(), snapshot: await repository.snapshot({ domain: 'planning.tasks' }) }
    await store.close(); store = null
    await fs.writeFile(path.join(app.getPath('userData'), 'packaged-result.json'), JSON.stringify(result), { mode: 0o600 })
    app.quit()
  } catch {
    await store?.close()
    await fs.writeFile(path.join(app.getPath('userData'), 'packaged-result.json'), JSON.stringify({ ok: false }), { mode: 0o600 })
    app.exit(1)
  }
})
