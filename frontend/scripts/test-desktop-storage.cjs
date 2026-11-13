'use strict'
const fs = require('node:fs/promises')
// Electron's patched fs treats the temporary archive as a directory during cleanup.
const cleanupFs = process.versions.electron ? require('original-fs').promises : fs
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const { createRequire } = require('node:module')
const { verifyStorageRuntime, verifyStoragePayload } = require('../desktop/verify-storage.cjs')
const { readVersion } = require('./app-version.cjs')
const desktop = path.join(__dirname, '../desktop')
const fromDesktop = createRequire(path.join(desktop, 'package.json'))
const executable = process.env.ELECTRON_EXECUTABLE || fromDesktop('electron')
async function run(args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: 'inherit' })
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Native storage test timed out')) }, 120000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error('Native storage test failed: ' + code)) })
  })
}
async function packaged() {
  const { Packager } = fromDesktop('app-builder-lib/out/packager')
  const packager = new Packager({ projectDir: desktop, config: { extraMetadata: { version: readVersion() } } })
  await packager.validateConfig()
  if (packager.metadata.version !== readVersion()) throw new Error('Desktop package version differs from frontend/package.json')
  const asar = process.env.ERP_ASAR_MODULE ? require(process.env.ERP_ASAR_MODULE) : fromDesktop('@electron/asar')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-packaged-storage-'))
  try {
    const source = path.join(root, 'source'), profile = path.join(root, 'profile')
    await fs.mkdir(source); await fs.mkdir(profile)
    const metadata = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'))
    for (const file of metadata.build.files) await fs.copyFile(path.join(desktop, file), path.join(source, file))
    await fs.copyFile(path.join(__dirname, '../tests/fixtures/storage-packaged-main.cjs'), path.join(source, 'storage-packaged-main.cjs'))
    await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'clockwork-storage-fixture', version: readVersion(), main: 'storage-packaged-main.cjs' }))
    const archive = path.join(root, 'app.asar')
    await asar.createPackageWithOptions(source, archive, { unpack: '{' + metadata.build.asarUnpack.join(',') + '}' })
    verifyStoragePayload(desktop, root)
    const env = { ...process.env, ERP_SQLITE_TEST_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE
    await run([archive, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], env)
    const result = JSON.parse(await fs.readFile(path.join(profile, 'packaged-result.json'), 'utf8'))
    if (!result.ok || !result.archive || result.version !== readVersion() || result.rows.length !== 1 || result.rows[0].idempotencyKey !== 'packaged-key' || result.snapshot.data.title !== 'Packaged') throw new Error('Packaged SQLite worker verification failed')
    console.log('PASS packaged ASAR worker: atomic projection, queue and receipt; no native addon ABI')
  } finally { await cleanupFs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
void (async () => {
  console.log(JSON.stringify(verifyStorageRuntime(executable)))
  if (!process.argv.includes('--package-only')) await run(['--test', path.join(__dirname, '../tests/desktop-storage.test.cjs'), path.join(__dirname, '../tests/desktop-command-queue.test.cjs')], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
  await packaged()
})().catch(error => { console.error(error.message); process.exitCode = 1 })
