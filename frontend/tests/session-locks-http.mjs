import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { test } from 'node:test'
import ts from 'typescript'

const api = process.env.RBAC_TEST_API_URL ?? 'http://127.0.0.1:8080/api/v1'
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(api).hostname), 'Loopback API required')
const env = Object.fromEntries(readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(line => /^[A-Z_]+=/.test(line)).map(line => {
  const split = line.indexOf('=')
  return [line.slice(0, split), line.slice(split + 1).replace(/^['"]|['"]$/g, '')]
}))
const password = process.env.RBAC_TEST_ADMIN_PASSWORD ?? env.ADMIN_PASSWORD
const source = ts.transpileModule(readFileSync(new URL('../src/sessionSync.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const workers = []
async function worker() {
  const instance = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads')
    const storage = new Map()
    global.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
    global.window = new EventTarget()
    import(workerData.moduleUrl).then(({ withRefreshLock }) => {
      parentPort.on('message', async message => {
        try {
          if (message.kind === 'hold') {
            await withRefreshLock(() => { parentPort.postMessage({ kind: 'held' }); return new Promise(() => {}) })
            return
          }
          const value = await withRefreshLock(async () => {
            if (message.kind === 'probe') return true
            const response = await fetch(workerData.api + '/auth/refresh', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ refresh_token: message.refresh }), signal: AbortSignal.timeout(10000),
            })
            const body = await response.json()
            return { status: response.status, access: body.data?.access_token, refresh: body.data?.refresh_token }
          })
          parentPort.postMessage({ kind: 'result', value })
        } catch (error) { parentPort.postMessage({ kind: 'error', message: error.message }) }
      })
      parentPort.postMessage({ kind: 'ready' })
    })
  `, { eval: true, workerData: { moduleUrl, api } })
  workers.push(instance)
  assert.equal((await once(instance, 'message'))[0].kind, 'ready')
  return instance
}
async function command(target, body) {
  const reply = once(target, 'message')
  target.postMessage(body)
  return (await reply)[0]
}

await test('independent session owners against the local API', { timeout: 30000 }, async t => {
  try {
    const first = await worker(), second = await worker()
    await t.test('a suspended owner does not block the competing caller', async () => {
      assert.equal((await command(first, { kind: 'hold' })).kind, 'held')
      assert.equal((await command(second, { kind: 'probe' })).value, null)
    })
    await t.test('closing the owner releases its native lock', async () => {
      await first.terminate()
      assert.equal((await command(second, { kind: 'probe' })).value, true)
    })
    const third = await worker()
    const login = await fetch(api + '/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password }), signal: AbortSignal.timeout(10000) })
    assert.equal(login.status, 200)
    let session = (await login.json()).data
    await t.test('successive owners rotate the shared session without 401 responses', async () => {
      for (const owner of [second, third, second]) {
        const reply = await command(owner, { kind: 'refresh', refresh: session.refresh_token })
        assert.equal(reply.kind, 'result')
        assert.equal(reply.value?.status, 200)
        assert.ok(reply.value.refresh && reply.value.access)
        session = { refresh_token: reply.value.refresh, access_token: reply.value.access }
      }
    })
    await t.test('projects, processes and tasks remain readable after rotation', async () => {
      const replies = await Promise.all(['planning/projects', 'planning/processes', 'planning/tasks'].map(path => fetch(api + '/' + path, { headers: { Authorization: 'Bearer ' + session.access_token }, signal: AbortSignal.timeout(10000) })))
      assert.deepEqual(replies.map(response => response.status), [200, 200, 200])
    })
  } finally {
    await Promise.all(workers.map(instance => instance.terminate()))
  }
})
