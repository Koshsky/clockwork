'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { readVersion } = require('./app-version.cjs')

function verifyRenderer(directory, target, version = readVersion()) {
  if (!['web', 'desktop'].includes(target)) throw new Error('Expected web or desktop renderer')
  const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'build-target.json'), 'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'precache-manifest.json'), 'utf8'))
  if (metadata.protocol !== 1 || metadata.target !== target || metadata.version !== version || manifest.version !== version) throw new Error('Renderer target/version mismatch')
  const relative = name => typeof name === 'string' && name.length > 0 && !name.includes('\\') && !name.startsWith('/') && !name.split('/').includes('..')
  if (!relative(metadata.entry) || !fs.statSync(path.join(directory, metadata.entry)).isFile()) throw new Error('Renderer entry is missing')
  if (!Array.isArray(metadata.modules) || !metadata.modules.every(relative) || !metadata.modules.includes('src/main.ts')) throw new Error('Invalid renderer module evidence')
  const runtime = target === 'web' ? 'src/platform/web.ts' : 'src/platform/desktop.ts'
  if (!metadata.modules.includes(runtime)) throw new Error('Renderer runtime is missing')
  if (target === 'web') {
    if (metadata.modules.some(file => file.startsWith('src/platform/build/desktop/'))) throw new Error('Desktop replacement in web renderer')
    for (const file of ['src/offline/db.ts', 'src/offline/outbox.ts', 'src/offline/desktopQueue.ts', 'src/offline/session.ts', 'src/offline/nativeEvents.ts', 'src/session/desktop.ts', 'src/platform/desktop.ts', 'src/store/data/applicationPorts.ts']) if (metadata.modules.includes(file)) throw new Error('Desktop engine in web renderer: ' + file)
  } else if (metadata.modules.some(file => file.startsWith('src/platform/build/web/') || file === 'src/platform/web.ts')) throw new Error('Web replacement in desktop renderer')
  for (const asset of manifest.assets || []) if (typeof asset !== 'string' || !asset.startsWith('/assets/') || !relative(asset.slice(1)) || !fs.statSync(path.join(directory, asset.slice(1))).isFile()) throw new Error('Invalid renderer asset manifest')
  if (!fs.statSync(path.join(directory, 'index.html')).isFile()) throw new Error('Renderer HTML is missing')
  return { target, version, modules: metadata.modules.length, entry: metadata.entry }
}
module.exports = { verifyRenderer }
if (require.main === module) {
  try { console.log(JSON.stringify(verifyRenderer(process.argv[2], process.argv[3]))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
