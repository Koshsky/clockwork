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
  let selected = 'https://company.example/api/v1', offline = false, missing = false, calls = 0, configuration, logoError
  const warnings = []
  const provider = () => createBrandingProvider({ directory, server: () => selected, report: code => warnings.push(code), fetch: async (url, options) => {
    calls++
    assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
    if (offline) throw new Error('offline')
    if (url.endsWith('/logo.png')) {
      if (logoError) throw logoError
      return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64'))
    }
    assert.equal(url, new URL(selected).origin + BRANDING_PATH)
    return new Response(JSON.stringify(configuration === undefined ? { name: new URL(url).hostname, primaryColor: '#7841AF' } : configuration), { status: missing ? 404 : 200 })
  } })
  return { provider, directory, warnings, configure: value => { configuration = value }, failLogo: error => { logoError = error }, select: server => { selected = server }, offline: () => { offline = true }, missing: () => { missing = true }, calls: () => calls }
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
for (const value of [[], null, 42, { error: 'upstream unavailable' }]) {
  test(`non-branding JSON ${JSON.stringify(value)} preserves the previous offline identity`, async t => {
    const f = await fixture(t), saved = await f.provider()()
    f.configure(value)
    assert.deepEqual(await f.provider()(), saved)
    f.offline()
    assert.deepEqual(await f.provider()(), saved)
  })
}
test('a transient logo error preserves the complete cached identity across offline restart', async t => {
  const f = await fixture(t)
  f.configure({ name: 'Company', primaryColor: '#7841AF', logo: 'logo.png' })
  const saved = await f.provider()()
  assert.match(saved.logo, /^data:image\/png/)
  f.configure({ name: 'New name', logo: 'logo.png' }); f.failLogo(new Error('sensitive-host-and-file-information'))
  assert.deepEqual(await f.provider()(), saved)
  f.offline()
  assert.deepEqual(await f.provider()(), saved)
  assert.ok(f.warnings.includes('logo-unavailable'))
  assert.ok(f.warnings.every(code => !code.includes('sensitive')))
})
test('superseded server fetches do not force the fifth selected server to use Clockwork', async t => {
  const f = await fixture(t)
  let selected, active = 0, peak = 0
  const warnings = []
  const provider = createBrandingProvider({ directory: f.directory, server: () => selected, report: code => warnings.push(code), fetch: (url, options) => {
    if (url.startsWith('https://server5.example/')) return Promise.resolve(new Response(JSON.stringify({ name: 'Fifth company' })))
    active++; peak = Math.max(peak, active)
    return new Promise((_, reject) => options.signal.addEventListener('abort', () => { active--; reject(new Error('aborted')) }, { once: true }))
  } })
  const old = []
  for (let number = 1; number <= 4; number++) { selected = `https://server${number}.example/api/v1`; old.push(provider()) }
  selected = 'https://server5.example/api/v1'
  assert.equal((await provider()).name, 'Fifth company')
  await Promise.all(old)
  assert.equal(peak, 1)
  assert.deepEqual(warnings, [])
})
test('branding cache evicts old origins within its disk budget and preserves unrelated profile files', async t => {
  const f = await fixture(t), provider = f.provider()
  await fs.writeFile(path.join(f.directory, 'queue.sqlite'), 'keep queued business data')
  for (let number = 0; number < 12; number++) { f.select(`https://server${number}.example/api/v1`); await provider() }
  const files = (await fs.readdir(f.directory)).filter(name => /^branding-.*\.json$/.test(name))
  assert.equal(files.length, 8)
  assert.equal(await fs.readFile(path.join(f.directory, 'queue.sqlite'), 'utf8'), 'keep queued business data')
  f.offline()
  assert.equal((await provider()).name, 'server11.example')
})
test('branding diagnostics are rate limited and contain no URLs, paths or response content', async t => {
  const f = await fixture(t), warnings = []
  let now = 100000
  const provider = createBrandingProvider({ directory: f.directory, server: () => 'https://private.example/api/v1', now: () => now, report: code => warnings.push(code), fetch: async () => new Response('secret/path/password') })
  await provider(); await provider()
  assert.deepEqual(warnings, ['config-unavailable-or-invalid'])
  now += 60001; await provider()
  assert.deepEqual(warnings, ['config-unavailable-or-invalid', 'config-unavailable-or-invalid'])
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
