import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const root = fileURLToPath(new URL('../', import.meta.url))
const { webPolicy } = createRequire(import.meta.url)('../desktop/security.cjs')
// Reuse an installed nginx image; no Docker build or frontend bundle is involved.
const image = process.env.CSP_NGINX_IMAGE || 'koshsky/erp-frontend:v1.6.0'
// Keep bind-mounted fixtures on the project volume shared with Docker.
mkdirSync(path.join(root, 'tmp'), { recursive: true })
const directory = mkdtempSync(path.join(root, 'tmp/erp-csp-nginx-'))
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim()
let container
try {
  mkdirSync(path.join(directory, 'assets/custom'), { recursive: true })
  for (const [name, body] of Object.entries({
    'index.html': '<!doctype html><title>CSP fixture</title>',
    'assets/app.js': 'console.log("fixture")',
    'assets/custom/icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'sw.js': 'self.close()',
    'manifest.webmanifest': '{}',
    'precache-manifest.json': '{"version":"fixture"}',
  })) writeFileSync(path.join(directory, name), body)
  container = docker('run', '--rm', '-d', '--platform', 'linux/amd64', '--entrypoint', 'nginx',
    '--publish', '127.0.0.1::80',
    '--mount', `type=bind,src=${root}nginx.conf,dst=/etc/nginx/conf.d/default.conf,readonly`,
    '--mount', `type=bind,src=${root}security-headers.conf,dst=/etc/nginx/snippets/erp-security-headers.conf,readonly`,
    '--mount', `type=bind,src=${directory},dst=/usr/share/nginx/html,readonly`, image, '-g', 'daemon off;')
  const base = 'http://' + docker('port', container, '80/tcp')
  for (const url of ['/', '/index.html', '/planner', '/assets/app.js', '/assets/custom/icon.svg', '/sw.js', '/manifest.webmanifest', '/precache-manifest.json', '/assets/missing.js']) {
    let response
    for (let attempt = 0; attempt < 30; attempt++) {
      try { response = await fetch(base + url); break } catch { await new Promise(resolve => setTimeout(resolve, 100)) }
    }
    assert.ok(response, 'nginx did not become ready')
    assert.equal(response.status, url.includes('missing') ? 404 : 200)
    assert.equal(response.headers.get('Content-Security-Policy'), webPolicy, url)
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', url)
    assert.equal(response.headers.get('X-Frame-Options'), 'DENY', url)
    if (url === '/assets/app.js') assert.ok(response.headers.get('Cache-Control').includes('immutable'))
    if (['/index.html', '/sw.js', '/manifest.webmanifest', '/precache-manifest.json', '/assets/custom/icon.svg'].includes(url)) {
      assert.equal(response.headers.get('Cache-Control'), 'no-cache', url)
    }
    console.log(`PASS nginx: ${url} (${response.status}) retains CSP and cache policy`)
  }
} finally {
  if (container) docker('stop', '--time', '1', container)
  rmSync(directory, { recursive: true, force: true })
}
