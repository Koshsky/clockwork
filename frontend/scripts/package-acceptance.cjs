'use strict'
const fs = require('node:fs/promises')
const path = require('node:path')
const { createRequire } = require('node:module')
const { createHash } = require('node:crypto')
const { readVersion } = require('./app-version.cjs')
const { verifyRenderer } = require('./verify-renderer.cjs')
const { verifyStoragePayload } = require('../desktop/verify-storage.cjs')
const { verifyWeb } = require('../desktop/verify-web.cjs')

async function acceptancePaths(web, output) {
  const input = await fs.realpath(web), requested = path.resolve(output)
  const leaf = await fs.lstat(requested).catch(error => { if (error.code === 'ENOENT') return null; throw error })
  if (leaf?.isSymbolicLink()) throw new Error('Acceptance output must not be a symlink')
  let ancestor = requested
  const suffix = []
  let resolved
  for (;;) {
    try { resolved = await fs.realpath(ancestor); break }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      suffix.unshift(path.basename(ancestor)); ancestor = path.dirname(ancestor)
    }
  }
  const destination = path.join(resolved, ...suffix)
  const contains = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
  if (contains(input, destination) || contains(destination, input)) throw new Error('Acceptance input and output paths must not overlap')
  return { input, destination }
}

// This fixture exercises actual packaged code without producing a distributable release.
async function packageAcceptance(web, output) {
  if (process.env.ERP_TEST_ISOLATED !== '1') throw new Error('An explicitly isolated acceptance profile is required')
  const frontend = path.join(__dirname, '..'), desktop = path.join(frontend, 'desktop')
  const version = readVersion(), renderer = verifyRenderer(web, 'desktop', version)
  const selected = await acceptancePaths(web, output)
  web = selected.input; output = selected.destination
  const existing = await fs.readdir(output).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  if (existing.length) throw new Error('Acceptance output must be empty')
  await fs.mkdir(output, { recursive: true, mode: 0o700 })
  const source = path.join(output, 'source'); await fs.mkdir(source)
  const metadata = JSON.parse(await fs.readFile(path.join(desktop, 'package.json'), 'utf8'))
  for (const file of metadata.build.files) await fs.copyFile(path.join(desktop, file), path.join(source, file))
  await fs.copyFile(path.join(frontend, 'tests/fixtures/artifact-main.cjs'), path.join(source, 'artifact-main.cjs'))
  await fs.cp(web, path.join(source, 'web'), { recursive: true })
  await fs.writeFile(path.join(source, 'package.json'), JSON.stringify({ ...metadata, version, main: 'artifact-main.cjs' }, null, 2) + '\n')
  const fromDesktop = createRequire(path.join(desktop, 'package.json'))
  const asar = fromDesktop('@electron/asar'), archive = path.join(output, 'app.asar')
  await asar.createPackageWithOptions(source, archive, { unpack: '{' + metadata.build.asarUnpack.join(',') + '}' })
  verifyStoragePayload(desktop, output)
  if (verifyWeb(web, path.join(source, 'web')).length) throw new Error('Acceptance renderer payload differs')
  const result = { fixture: true, version, target: renderer.target, archive, archiveSha256: createHash('sha256').update(await fs.readFile(archive)).digest('hex'), rendererModules: renderer.modules, desktopFiles: metadata.build.files }
  await fs.writeFile(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
  return result
}
module.exports = { packageAcceptance }
if (require.main === module) {
  void packageAcceptance(process.argv[2], process.argv[3]).then(result => console.log(JSON.stringify({ fixture: true, version: result.version, archive: result.archive }))).catch(error => { console.error(error.message); process.exitCode = 1 })
}
