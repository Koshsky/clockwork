'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { verifyRenderer } = require('../scripts/verify-renderer.cjs')
const composition = import('../scripts/build-targets.mjs')
const root = '/project/frontend'
test('production target defaults to web, development remains auto and invalid production composition fails closed', async () => {
  const { buildTarget } = await composition
  assert.equal(buildTarget('build', ''), 'web'); assert.equal(buildTarget('serve', ''), 'auto')
  assert.equal(buildTarget('build', 'desktop'), 'desktop')
  for (const value of ['auto', 'other', 'WEB', '../desktop']) assert.throws(() => buildTarget('build', value))
})
test('web replacements resolve equivalent aliases, relative paths, extensions and Vue queries', async () => {
  const { rendererReplacement } = await composition
  for (const [source, importer] of [['@/offline/db', root + '/src/http.ts'], ['./offline/db', root + '/src/http.ts'], ['../offline/db.ts', root + '/src/platform/cacheStore.ts'], [root + '/src/offline/db.ts', root + '/src/App.vue?vue&type=script']]) assert.equal(rendererReplacement('web', root, source, importer), root + '/src/platform/build/web/db.ts')
  assert.equal(rendererReplacement('web', root, '@/offline/dbExtra', root + '/src/http.ts'), null)
  assert.equal(rendererReplacement('web', root, '@/offline/db.test.ts', root + '/src/http.ts'), null)
})
test('Windows drive and path separators preserve exact replacement boundaries', async () => {
  const { rendererReplacement } = await composition
  assert.equal(rendererReplacement('web', 'C:\\app\\frontend', '..\\offline\\db.ts', 'C:\\app\\frontend\\src\\platform\\cacheStore.ts'), 'C:/app/frontend/src/platform/build/web/db.ts')
})
test('desktop and automatic development never replace native storage with web stubs', async () => {
  const { rendererReplacement } = await composition
  for (const target of ['desktop', 'auto']) assert.equal(rendererReplacement(target, root, '@/offline/db', root + '/src/http.ts'), null)
  assert.equal(rendererReplacement('desktop', root, '@/platform/context', root + '/src/http.ts'), root + '/src/platform/build/desktop/context.ts')
  assert.equal(rendererReplacement('auto', root, '@/platform/context', root + '/src/http.ts'), null)
})
test('module graph gate rejects a real persistent engine in web and a web adapter in desktop', async () => {
  const { inspectRendererModules } = await composition
  for (const source of ['offline/db', 'offline/outbox', 'offline/desktopQueue', 'session/desktop', 'platform/desktop']) assert.throws(() => inspectRendererModules('web', root, [root + '/src/' + source + '.ts']))
  assert.throws(() => inspectRendererModules('desktop', root, [root + '/src/platform/build/web/outbox.ts']))
  assert.throws(() => inspectRendererModules('desktop', root, [root + '/src/platform/web.ts']))
  assert.throws(() => inspectRendererModules('web', root, [root + '/src/platform/build/desktop/context.ts']))
  assert.deepEqual(inspectRendererModules('web', root, [root + '/src/offline/mutationGuard.ts', root + '/src/platform/build/web/outbox.ts']), ['src/offline/mutationGuard.ts', 'src/platform/build/web/outbox.ts'])
})
async function artifact(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-renderer-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  await fs.mkdir(path.join(directory, 'assets')); await fs.writeFile(path.join(directory, 'assets/entry.js'), 'fixture'); await fs.writeFile(path.join(directory, 'index.html'), '<script src="/assets/entry.js"></script>')
  const metadata = { protocol: 1, target: 'web', version: '1.2.3', entry: 'assets/entry.js', modules: ['src/main.ts', 'src/platform/web.ts'] }
  await fs.writeFile(path.join(directory, 'build-target.json'), JSON.stringify(metadata))
  await fs.writeFile(path.join(directory, 'precache-manifest.json'), JSON.stringify({ version: '1.2.3', assets: ['/assets/entry.js'] }))
  return { directory, metadata, save: () => fs.writeFile(path.join(directory, 'build-target.json'), JSON.stringify(metadata)) }
}
test('artifact gate verifies platform and canonical versions instead of accepting a stale web build for desktop', async t => {
  const f = await artifact(t)
  assert.equal(verifyRenderer(f.directory, 'web', '1.2.3').target, 'web')
  assert.throws(() => verifyRenderer(f.directory, 'desktop', '1.2.3'), /mismatch/)
  assert.throws(() => verifyRenderer(f.directory, 'web', '1.2.4'), /mismatch/)
})
test('artifact gate rejects a missing entry, traversal and inconsistent module evidence', async t => {
  const f = await artifact(t)
  f.metadata.entry = '../secret.js'; await f.save(); assert.throws(() => verifyRenderer(f.directory, 'web', '1.2.3'))
  f.metadata.entry = 'assets/missing.js'; await f.save(); assert.throws(() => verifyRenderer(f.directory, 'web', '1.2.3'))
  f.metadata.entry = 'assets/entry.js'; f.metadata.modules.push('src/offline/outbox.ts'); await f.save(); assert.throws(() => verifyRenderer(f.directory, 'web', '1.2.3'))
})
test('Docker and desktop packaging select and verify their own renderer target', async () => {
  const docker = await fs.readFile(path.join(__dirname, '../Dockerfile'), 'utf8')
  const portable = await fs.readFile(path.join(__dirname, '../desktop/build-portable.sh'), 'utf8')
  assert.match(docker, /ERP_BUILD_TARGET=web npm run build/)
  assert.match(portable, /ERP_BUILD_TARGET=desktop npm run build/)
  assert.match(docker, /verify-renderer.cjs.*web/)
  assert.match(portable, /verify-renderer.cjs.*desktop/)
})
test('cross-platform build wrapper pins target and source directory without independent versions', () => {
  const { rendererBuildPlan } = require('../scripts/build-renderer.cjs')
  for (const target of ['web', 'desktop']) {
    const plan = rendererBuildPlan(target, ['--outDir', '/tmp/fixture'])
    assert.equal(plan.options.env.ERP_BUILD_TARGET, target)
    assert.equal(plan.options.cwd, path.join(__dirname, '..'))
    assert.deepEqual(plan.args.slice(-3), ['build', '--outDir', '/tmp/fixture'])
  }
  assert.throws(() => rendererBuildPlan('auto'))
})
test('desktop builder refuses an unverified web renderer before invoking packaging', async t => {
  const { spawnSync } = require('node:child_process'), f = await artifact(t)
  const version = require('../scripts/app-version.cjs').readVersion()
  f.metadata.version = version; await f.save()
  await fs.writeFile(path.join(f.directory, 'precache-manifest.json'), JSON.stringify({ version, assets: ['/assets/entry.js'] }))
  assert.equal(verifyRenderer(f.directory, 'web', version).target, 'web')
  const config = path.join(f.directory, 'builder.json'), hook = path.join(f.directory, 'no-packager.cjs'), marker = path.join(f.directory, 'packager-called')
  await fs.writeFile(config, JSON.stringify({ extraResources: [{ from: f.directory, to: 'web' }] }))
  // A broken gate must fail the test without starting a real package build.
  await fs.writeFile(hook, `require('node:child_process').spawnSync = () => { require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'called'); return { status: 0 } }`)
  const result = spawnSync(process.execPath, ['--require', hook, path.join(__dirname, '../desktop/build.cjs'), '--config', config, '--publish', 'never'], { env: { ...process.env, ERP_DESKTOP_RENDERER_DIR: f.directory }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Renderer target\/version mismatch/)
  await assert.rejects(fs.access(marker), { code: 'ENOENT' })
})
test('the configured Vite resolver rejects native renderer imports without running a build', async () => {
  const { resolveConfig } = await import('vite')
  const config = await resolveConfig({ root: path.join(__dirname, '..'), configFile: path.join(__dirname, '../vite.config.ts') }, 'build')
  const guard = config.plugins.find(plugin => plugin.name === 'renderer-platform-boundary')
  assert.ok(guard)
  const context = { error(message) { throw new Error(message) } }
  assert.throws(() => guard.resolveId.call(context, 'node:fs', '/src/main.ts'), /Native import in renderer/)
  assert.equal(guard.resolveId.call(context, './web', '/src/main.ts'), null)
  assert.equal(guard.resolveId.call(context, 'node:fs', undefined), null)
})
test('desktop default packaging keeps the legacy renderer location without custom mode restrictions', () => {
  const { rendererDirectory } = require('../desktop/build.cjs')
  assert.equal(rendererDirectory(['--win', '-c.win.target=zip'], ''), path.join(__dirname, '../dist'))
})
test('custom renderer packaging binds its absolute JSON web resource to the verified real directory', async t => {
  const { rendererDirectory } = require('../desktop/build.cjs'), f = await desktopArtifact(t)
  const config = path.join(f.directory, 'builder.json')
  await fs.writeFile(config, JSON.stringify({ extraResources: [{ from: f.directory, to: 'web', filter: ['**/*'] }] }))
  assert.equal(rendererDirectory(['--win', 'zip', '--config', config, '--publish', 'never'], f.directory), f.directory)
  const alias = path.join(f.directory, 'renderer-link')
  await fs.symlink(f.directory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(rendererDirectory(['--config', config], alias), alias)
})
test('custom renderer rejects missing, different, duplicate, relative and inherited web resource mappings', async t => {
  const { rendererDirectory } = require('../desktop/build.cjs'), f = await desktopArtifact(t)
  const config = path.join(f.directory, 'builder.json'), web = { from: f.directory, to: 'web' }
  for (const metadata of [{}, { extraResources: [] }, { extraResources: [{ ...web, to: 'other' }] }, { extraResources: [{ ...web, from: path.dirname(f.directory) }] }, { extraResources: [{ ...web, from: '../dist' }] }, { extraResources: [web, web] }, { extends: 'base.json', extraResources: [web] }, ...['win', 'linux', 'mac'].map(platform => ({ extraResources: [web], [platform]: { extraResources: [] } }))]) {
    await fs.writeFile(config, JSON.stringify(metadata))
    assert.throws(() => rendererDirectory(['--config', config], f.directory), /Custom renderer/)
  }
})
test('custom renderer rejects absent, conflicting and prepackaged CLI configurations', async t => {
  const { rendererDirectory } = require('../desktop/build.cjs'), f = await desktopArtifact(t)
  const config = path.join(f.directory, 'builder.json')
  await fs.writeFile(config, JSON.stringify({ extraResources: [{ from: f.directory, to: 'web' }] }))
  for (const args of [[], ['--config'], ['--config', 'config.yml'], ['--config=' + config], ['-c', config], ['--config', config, '--config', config], ...['-c.extraResources=[]', '--config.extraResources=[]', '--config={}', '--prepackaged', '--prepackaged=old'].map(arg => ['--config', config, arg])]) assert.throws(() => rendererDirectory(args, f.directory), /Custom renderer/)
})
test('standalone custom renderer invocation fails before starting any packager when its mapping is absent', async t => {
  const { spawnSync } = require('node:child_process'), f = await desktopArtifact(t)
  const result = spawnSync(process.execPath, [path.join(__dirname, '../desktop/build.cjs'), '--win', 'zip'], { env: { ...process.env, ERP_DESKTOP_RENDERER_DIR: f.directory }, encoding: 'utf8' })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Custom renderer requires one --config/)
  assert.doesNotMatch(result.stderr, /Cannot find module|electron-builder/)
})
test('clean web builds use the same-origin API and reject cross-origin cookie sessions', async () => {
  const { webApiPath } = await composition
  for (const value of [undefined, '', '/api/v1', '/api/v1/']) assert.equal(webApiPath(value), '/api/v1')
  for (const value of ['http://localhost:8080/api/v1', 'https://api.example/api/v1', '//api.example/api/v1', '/other/api/v1', ' /api/v1', '/api/v1?redirect=other']) assert.throws(() => webApiPath(value), /same-origin/)
})
test('acceptance packaging requires explicit isolation and cannot use a web renderer as desktop', async t => {
  const { packageAcceptance } = require('../scripts/package-acceptance.cjs')
  const f = await artifact(t), before = process.env.ERP_TEST_ISOLATED
  try {
    delete process.env.ERP_TEST_ISOLATED
    await assert.rejects(packageAcceptance(f.directory, path.join(f.directory, 'package')), /isolated/)
    process.env.ERP_TEST_ISOLATED = '1'
    await assert.rejects(packageAcceptance(f.directory, path.join(f.directory, 'package')), /mismatch/)
  } finally { if (before === undefined) delete process.env.ERP_TEST_ISOLATED; else process.env.ERP_TEST_ISOLATED = before }
})
async function desktopArtifact(t) {
  const f = await artifact(t), { readVersion } = require('../scripts/app-version.cjs')
  f.metadata.target = 'desktop'; f.metadata.version = readVersion(); f.metadata.modules = ['src/main.ts', 'src/platform/desktop.ts']
  await f.save()
  await fs.writeFile(path.join(f.directory, 'precache-manifest.json'), JSON.stringify({ version: readVersion(), assets: ['/assets/entry.js'] }))
  return f
}
test('acceptance packaging rejects existing and nonexistent outputs intersecting its input before writing', async t => {
  const { packageAcceptance } = require('../scripts/package-acceptance.cjs'), f = await desktopArtifact(t)
  const before = process.env.ERP_TEST_ISOLATED
  try {
    process.env.ERP_TEST_ISOLATED = '1'
    const empty = path.join(f.directory, 'existing'); await fs.mkdir(empty)
    for (const output of [f.directory, empty, path.join(f.directory, 'new', 'nested'), path.dirname(f.directory)]) await assert.rejects(packageAcceptance(f.directory, output), /must not overlap/)
    assert.deepEqual(await fs.readdir(empty), [])
    await assert.rejects(fs.access(path.join(f.directory, 'new')), { code: 'ENOENT' })
  } finally { if (before === undefined) delete process.env.ERP_TEST_ISOLATED; else process.env.ERP_TEST_ISOLATED = before }
})
test('acceptance packaging rejects an output symlink and resolves nonexistent children through a symlinked parent', async t => {
  const { packageAcceptance } = require('../scripts/package-acceptance.cjs'), f = await desktopArtifact(t)
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'clockwork-output-')); t.after(() => fs.rm(outside, { recursive: true, force: true }))
  const empty = path.join(outside, 'empty'); await fs.mkdir(empty)
  const leaf = path.join(outside, 'leaf'), parent = path.join(outside, 'input-link')
  await fs.symlink(empty, leaf, process.platform === 'win32' ? 'junction' : 'dir')
  await fs.symlink(f.directory, parent, process.platform === 'win32' ? 'junction' : 'dir')
  const before = process.env.ERP_TEST_ISOLATED
  try {
    process.env.ERP_TEST_ISOLATED = '1'
    await assert.rejects(packageAcceptance(f.directory, leaf), /must not be a symlink/)
    await assert.rejects(packageAcceptance(f.directory, path.join(parent, 'new', 'nested')), /must not overlap/)
    assert.deepEqual(await fs.readdir(empty), [])
    await assert.rejects(fs.access(path.join(f.directory, 'new')), { code: 'ENOENT' })
  } finally { if (before === undefined) delete process.env.ERP_TEST_ISOLATED; else process.env.ERP_TEST_ISOLATED = before }
})
