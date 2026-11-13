import { _electron, expect } from 'playwright/test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import https from 'node:https'
const target = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !target || !['localhost', '127.0.0.1'].includes(new URL(target).hostname)) throw new Error('An isolated local API and profile are required')
const root = mkdtempSync(path.join(tmpdir(), 'clockwork-security-shell-')), web = path.join(root, 'web'), profile = path.join(root, 'profile')
mkdirSync(web); mkdirSync(profile)
writeFileSync(path.join(web, 'index.html'), '<!doctype html><html><body><a id="external" target="_blank" href="https://example.invalid/help">External help</a><a id="internal" target="_blank" href="/planner?unit=week">Local planning</a><a id="unsafe" target="_blank" href="file:///private/profile">Denied</a></body></html>')
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' })
let credentialRequests = 0, native
const tls = https.createServer({ key: readFileSync(path.join(root, 'key.pem')), cert: readFileSync(path.join(root, 'cert.pem')) }, (req, res) => {
 if (req.url.includes('/auth/')) credentialRequests++
 res.writeHead(500); res.end('{}')
})
await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve))
try {
 const env = { ...process.env, ERP_SECURITY_PROFILE: profile, ERP_SECURITY_WEB_DIR: web }; delete env.ELECTRON_RUN_AS_NODE
 native = await _electron.launch({ executablePath: process.env.ELECTRON_EXECUTABLE, args: ['--force-color-profile=srgb', fileURLToPath(new URL('./fixtures/security-shell-main.cjs', import.meta.url))], env })
 const page = await native.firstWindow()
 await page.waitForURL(url => url.origin.startsWith('http://127.0.0.1:'))
 const origin = new URL(page.url()).origin
 await expect.poll(() => page.evaluate(() => Boolean(window.erpDesktop?.session))).toBe(true)
 await page.evaluate(async server => window.erpDesktop.session.selectServer(server), `https://127.0.0.1:${tls.address().port}`)
 const rejected = await page.evaluate(async () => { try { await window.erpDesktop.session.login('untrusted', 'must-not-cross-tls'); return false } catch { return true } })
 expect(rejected).toBe(true); expect(credentialRequests).toBe(0)
 expect(await page.evaluate(async () => (await window.erpDesktop.session.status()).mode)).toBe('signedOut')
 console.log('PASS production shell rejects an untrusted self-signed peer before sending credentials')
 const session = await page.evaluate(async ({ target, password }) => { await window.erpDesktop.session.selectServer(target); return window.erpDesktop.session.login('admin', password) }, { target, password })
 expect(session.mode).toBe('online'); expect(JSON.stringify(session)).not.toMatch(/access_token|refresh_token|must-not-cross-tls/)
 await expect.poll(async () => {
  try { return await page.evaluate(async () => (await window.erpDesktop.session.api({ operation: 'GET /project', requestId: crypto.randomUUID(), contextId: (await window.erpDesktop.session.status()).contextId })).status) }
  catch { return 0 }
 }, { timeout: 15000 }).toBe(200)
 expect(await page.evaluate(() => window.erpDesktop.session.probe())).toBe(true)
 expect(await page.evaluate(async target => fetch(target + '/api/v1/health').then(() => true, () => false), target)).toBe(false)
 console.log('PASS main-owned cross-origin API works while the renderer CSP blocks remote fetch')
 await page.evaluate(() => window.open('https://example.invalid/automatic', '_blank'))
 await page.waitForTimeout(100)
 expect(await native.evaluate(() => globalThis.securityExternalLinks)).toEqual([]); expect(native.windows()).toHaveLength(1)
 await page.locator('#external').click()
 await expect.poll(() => native.evaluate(() => globalThis.securityExternalLinks)).toEqual(['https://example.invalid/help'])
 expect(native.windows()).toHaveLength(1)
 await page.locator('#unsafe').click(); await page.waitForTimeout(100)
 expect(native.windows()).toHaveLength(1); expect(await native.evaluate(() => globalThis.securityExternalLinks)).toHaveLength(1)
 console.log('PASS explicit safe links use the stubbed OS browser; automatic and file popups are denied')
 await page.locator('#internal').click(); await expect.poll(() => native.windows().length).toBe(2)
 const child = native.windows().find(window => window !== page)
 await expect(child).toHaveURL(origin + '/planner?unit=week')
 expect(await child.evaluate(async () => (await window.erpDesktop.service.status()).phase)).toBe('ready')
 await child.close()
 await page.evaluate(() => { location.href = URL.createObjectURL(new Blob(['<h1>Untrusted document</h1>'], { type: 'text/html' })) })
 await page.waitForTimeout(100); expect(page.url()).toBe(origin + '/')
 console.log('PASS trusted local popup gets attached IPC; blob main-frame navigation stays blocked')
 await page.evaluate(() => window.erpDesktop.session.logout())
 expect(await page.evaluate(async () => (await window.erpDesktop.session.status()).mode)).toBe('signedOut')
} finally {
 if (native) await native.close()
 await new Promise(resolve => tls.close(resolve))
 rmSync(root, { recursive: true, force: true })
}
