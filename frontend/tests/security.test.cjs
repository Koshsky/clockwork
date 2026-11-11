'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const http = require('node:http')
const { webPolicy, desktopPolicy, securityHeaders } = require('../desktop/security.cjs')
const { createStaticHandler } = require('../desktop/static-server.cjs')
const root = path.join(__dirname, '..')
const directives = policy => Object.fromEntries(policy.split('; ').map(value => {
  const [name, ...sources] = value.split(' ')
  return [name, sources]
}))

for (const [name, policy] of Object.entries({ web: webPolicy, desktop: desktopPolicy })) {
  test(`${name}: executable code stays local and inline JavaScript/eval stay blocked`, () => {
    const d = directives(policy)
    assert.deepEqual(d['default-src'], ["'none'"])
    assert.deepEqual(d['script-src'], ["'self'"])
    assert.deepEqual(d['script-src-attr'], ["'none'"])
    assert.deepEqual(d['worker-src'], ["'self'"])
    assert.deepEqual(d['object-src'], ["'none'"])
    assert.deepEqual(d['base-uri'], ["'none'"])
    assert.deepEqual(d['frame-ancestors'], ["'none'"])
  })
  test(`${name}: Gantt CSS, captured images, fonts and local printing remain allowed`, () => {
    const d = directives(policy)
    assert.deepEqual(d['style-src'], ["'self'", "'unsafe-inline'"])
    assert.ok(d['img-src'].includes('data:'))
    assert.ok(d['font-src'].includes('data:'))
    assert.deepEqual(d['frame-src'], ["'self'"])
    assert.deepEqual(d['manifest-src'], ["'self'"])
  })
}
test('only desktop network requests can use the configurable HTTP(S) backend', () => {
  assert.deepEqual(directives(webPolicy)['connect-src'], ["'self'"])
  assert.deepEqual(directives(desktopPolicy)['connect-src'], ["'self'", 'https:', 'http:'])
  assert.ok(!desktopPolicy.includes('*'))
})
test('nginx policy is identical to its source, including headers on error responses', () => {
  const expected = Object.entries({ ...securityHeaders(webPolicy), 'Strict-Transport-Security': 'max-age=31536000' })
    .map(([name, value]) => `add_header ${name} "${value}" always;`)
  const actual = readFileSync(path.join(root, 'security-headers.conf'), 'utf8').split('\n').filter(line => line.startsWith('add_header'))
  assert.deepEqual(actual, expected)
})
test('every nginx location overriding add_header explicitly includes all security headers', () => {
  const nginx = readFileSync(path.join(root, 'nginx.conf'), 'utf8')
  const locations = [...nginx.matchAll(/location[^\n]+\{([^}]+)\}/g)].map(match => match[1])
  assert.ok(locations.length >= 7)
  for (const location of locations.filter(value => value.includes('add_header'))) {
    assert.ok(location.includes('include /etc/nginx/snippets/erp-security-headers.conf;'))
  }
  assert.ok(readFileSync(path.join(root, 'Dockerfile'), 'utf8').includes('COPY security-headers.conf /etc/nginx/snippets/erp-security-headers.conf'))
})
test('desktop packaging includes the policy and the server using it', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'desktop/package.json'), 'utf8'))
  for (const file of ['security.cjs', 'static-server.cjs']) assert.ok(pkg.build.files.includes(file))
})

test('desktop HTTP server delivers the enforced policy for HTML, assets, routes and failures', async t => {
  const webDir = mkdtempSync(path.join(tmpdir(), 'erp-csp-static-'))
  mkdirSync(path.join(webDir, 'assets'))
  writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>ERP fixture</title>')
  writeFileSync(path.join(webDir, 'assets', 'worker.mjs'), 'self.close()')
  writeFileSync(path.join(webDir, 'precache-manifest.json'), '{"version":"fixture"}')
  const server = http.createServer(createStaticHandler(webDir))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(webDir, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.address().port}`
  for (const [url, status, cache] of [
    ['/', 200, 'no-cache'], ['/planner', 200, 'no-cache'],
    ['/assets/worker.mjs', 200, 'public, max-age=31536000, immutable'],
    ['/precache-manifest.json', 200, 'no-cache'], ['/%zz', 400, null],
  ]) {
    await t.test(url, async () => {
      const response = await fetch(base + url)
      assert.equal(response.status, status)
      for (const [name, value] of Object.entries(securityHeaders())) assert.equal(response.headers.get(name), value)
      if (cache) assert.equal(response.headers.get('Cache-Control'), cache)
    })
  }
  rmSync(path.join(webDir, 'index.html'))
  const missing = await fetch(base + '/missing')
  assert.equal(missing.status, 404)
  assert.equal(missing.headers.get('Content-Security-Policy'), desktopPolicy)
})
