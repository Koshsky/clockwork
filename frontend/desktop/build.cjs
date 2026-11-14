'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { verifyRenderer } = require('../scripts/verify-renderer.cjs')
const { readVersion } = require('../scripts/app-version.cjs')

function builderArguments(args) {
  const version = readVersion()
  if (args.some(arg => /extraMetadata(?:\.|=)|^--version(?:=|$)/.test(arg))) throw new Error('Set the frontend version only in frontend/package.json')
  return [...args, '-c.extraMetadata.version=' + version]
}
function rendererDirectory(args, renderer = process.env.ERP_DESKTOP_RENDERER_DIR) {
  if (!renderer) return path.join(__dirname, '../dist')
  const configs = args.flatMap((arg, index) => arg === '--config' ? [index] : [])
  if (configs.length !== 1 || args.some(arg => /^-c|^--config[.=]|^--prepackaged(?:=|$)/.test(arg))) throw new Error('Custom renderer requires one --config JSON file without CLI config overrides or --prepackaged')
  const file = args[configs[0] + 1]
  if (!file || path.extname(file) !== '.json') throw new Error('Custom renderer requires a JSON config file')
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, file), 'utf8'))
  if (config.extends != null || ['win', 'linux', 'mac'].some(platform => config[platform]?.extraResources != null)) throw new Error('Custom renderer config cannot inherit or override extraResources')
  const resources = config.extraResources
  const web = Array.isArray(resources) && resources.length === 1 && resources[0]
  if (!web || web.to !== 'web' || typeof web.from !== 'string' || !path.isAbsolute(web.from) || fs.realpathSync(web.from) !== fs.realpathSync(renderer)) throw new Error('Custom renderer must match the single absolute extraResources web mapping')
  return renderer
}
if (require.main === module) {
  try {
    const input = process.argv.slice(2)
    const args = builderArguments(input)
    verifyRenderer(rendererDirectory(input), 'desktop')
    const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], { cwd: __dirname, env: process.env, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { builderArguments, rendererDirectory }
