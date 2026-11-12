'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const { readVersion } = require('../scripts/app-version.cjs')
const { builderArguments } = require('../desktop/build.cjs')
const frontend = path.join(__dirname, '..')
async function fixture(t, metadata = { version: '2.3.4' }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-version-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'package.json')
  await fs.writeFile(file, JSON.stringify(metadata))
  return { directory, file }
}

test('the canonical version is independent of the working directory and Git history', async t => {
  const { directory } = await fixture(t)
  assert.equal(readVersion(directory, ''), '2.3.4')
  const child = spawnSync(process.execPath, [path.join(frontend, 'scripts/app-version.cjs')], { cwd: directory, env: { ...process.env, APP_VERSION: '' }, encoding: 'utf8' })
  assert.equal(child.status, 0); assert.equal(child.stdout.trim(), readVersion(frontend, ''))
})
test('changing the source version takes effect without a generated copy or module-cache reset', async t => {
  const { directory, file } = await fixture(t)
  assert.equal(readVersion(directory, ''), '2.3.4')
  await fs.writeFile(file, JSON.stringify({ version: '2.4.0' }))
  assert.equal(readVersion(directory, ''), '2.4.0')
})
test('missing, malformed and noncanonical source versions fail instead of using dev or Git', async t => {
  const { directory, file } = await fixture(t)
  for (const version of [undefined, null, 1, '', '1.2', 'v1.2.3', '01.2.3', '1.02.3', '1.2.03', '1.2.3-beta', '1.2.3+build', '1.2.3\n']) {
    await fs.writeFile(file, JSON.stringify({ version })); assert.throws(() => readVersion(directory, ''))
  }
  await fs.writeFile(file, '{'); assert.throws(() => readVersion(directory, ''))
  await fs.unlink(file); assert.throws(() => readVersion(directory, ''))
})
test('APP_VERSION is an assertion of the source version and cannot override it', async t => {
  const { directory } = await fixture(t)
  assert.equal(readVersion(directory, '2.3.4'), '2.3.4')
  assert.throws(() => readVersion(directory, '2.3.5'), /must match/)
  assert.throws(() => readVersion(directory, 'dev'), /must match/)
})
test('the version CLI fails closed on a mismatched build environment', () => {
  const child = spawnSync(process.execPath, [path.join(frontend, 'scripts/app-version.cjs')], { env: { ...process.env, APP_VERSION: 'invalid' }, encoding: 'utf8' })
  assert.equal(child.status, 1); assert.equal(child.stdout, ''); assert.match(child.stderr, /must match/)
})
test('every desktop target receives the canonical version without modifying package metadata', async () => {
  const before = await fs.readFile(path.join(frontend, 'desktop/package.json'))
  for (const target of ['win', 'linux', 'mac']) assert.deepEqual(builderArguments(['--' + target]), ['--' + target, '-c.extraMetadata.version=' + readVersion()])
  assert.deepEqual(await fs.readFile(path.join(frontend, 'desktop/package.json')), before)
})
test('desktop callers cannot supply an independent package version', () => {
  for (const arg of ['--version=9.0.0', '--version', '-c.extraMetadata.version=9.0.0', '--config.extraMetadata.version=9.0.0', '-c.extraMetadata={}']) assert.throws(() => builderArguments([arg]), /only in frontend/)
})
test('desktop manifests and lockfile metadata contain no independent application version', async () => {
  const metadata = JSON.parse(await fs.readFile(path.join(frontend, 'desktop/package.json')))
  const lock = JSON.parse(await fs.readFile(path.join(frontend, 'desktop/package-lock.json')))
  assert.equal(metadata.version, undefined); assert.equal(lock.version, undefined); assert.equal(lock.packages[''].version, undefined)
})
test('Vite injects the canonical version into both its UI define and generated manifest', async t => {
  const { directory } = await fixture(t)
  const { resolveConfig } = await import('vite')
  const config = await resolveConfig({ root: frontend, configFile: path.join(frontend, 'vite.config.ts') }, 'build')
  const version = readVersion()
  assert.equal(config.define.__APP_VERSION__, JSON.stringify(version))
  const plugin = config.plugins.find(plugin => plugin.name === 'version-manifest')
  assert.ok(plugin)
  plugin.configResolved({ ...config, build: { ...config.build, outDir: directory } })
  plugin.closeBundle()
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'precache-manifest.json'))).version, version)
})
