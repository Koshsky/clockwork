'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { createBrandingProvider } = require('../desktop/branding.cjs')
const { createStaticHandler } = require('../desktop/static-server.cjs')
const { DEFAULT_BRANDING, BRANDING_PATH } = require('../desktop/command-branding.cjs')

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-branding-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  let selected = 'https://company.example/api/v1', offline = false, missing = false, calls = 0
  const provider = () => createBrandingProvider({ directory, server: () => selected, fetch: async (url, options) => {
    calls++
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    if (offline) throw new Error('offline')
    assert.equal(url, new URL(selected).origin + BRANDING_PATH)
    return new Response(JSON.stringify({ name: new URL(url).hostname, primaryColor: '#7841AF' }), { status: missing ? 404 : 200 })
  } })
  return { provider, directory, select: server => { selected = server }, offline: () => { offline = true }, missing: () => { missing = true }, calls: () => calls }
}

test('desktop restores per-server company branding after an offline restart', async t => {
  const f = await fixture(t)
  const saved = await f.provider()()
  assert.equal(saved.name, 'company.example')
  f.offline()
  assert.deepEqual(await f.provider()(), saved)
})
test('desktop never displays another server branding while offline', async t => {
  const f = await fixture(t)
  await f.provider()()
  f.select('https://other.example/api/v1'); f.offline()
  assert.deepEqual(await f.provider()(), DEFAULT_BRANDING)
})
test('removing the server file clears its previous cached brand', async t => {
  const f = await fixture(t)
  await f.provider()()
  f.missing()
  assert.deepEqual(await f.provider()(), DEFAULT_BRANDING)
  f.offline()
  assert.deepEqual(await f.provider()(), DEFAULT_BRANDING)
})
test('unselected server uses Clockwork without a request', async t => {
  const f = await fixture(t)
  f.select(null)
  assert.deepEqual(await f.provider()(), DEFAULT_BRANDING)
  assert.equal(f.calls(), 0)
})
test('simultaneous windows share a single native branding request', async t => {
  const f = await fixture(t), provider = f.provider()
  const results = await Promise.all([provider(), provider(), provider()])
  assert.equal(f.calls(), 1)
  assert.deepEqual(results[0], results[2])
})
test('corrupt cached identity cannot prevent opening offline', async t => {
  const f = await fixture(t)
  await f.provider()()
  for (const name of await fs.readdir(f.directory)) await fs.writeFile(path.join(f.directory, name), '<script>bad</script>')
  f.offline()
  assert.deepEqual(await f.provider()(), DEFAULT_BRANDING)
})
test('local HTTP branding stays no-store and same-origin under the existing CSP', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.directory, 'index.html'), 'app')
  const server = http.createServer(createStaticHandler(f.directory, { branding: f.provider() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = 'http://127.0.0.1:' + server.address().port
  const response = await fetch(origin + BRANDING_PATH)
  assert.equal(response.status, 200)
  assert.equal((await response.json()).name, 'company.example')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.ok(response.headers.get('Content-Security-Policy').includes("connect-src 'self'"))
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null)
  assert.equal((await fetch(origin + BRANDING_PATH, { method: 'POST' })).status, 405)
})
