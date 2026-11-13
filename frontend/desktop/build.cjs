'use strict'

const { spawnSync } = require('node:child_process')
const path = require('node:path')
const { verifyRenderer } = require('../scripts/verify-renderer.cjs')
const { readVersion } = require('../scripts/app-version.cjs')

function builderArguments(args) {
  const version = readVersion()
  if (args.some(arg => /extraMetadata(?:\.|=)|^--version(?:=|$)/.test(arg))) throw new Error('Set the frontend version only in frontend/package.json')
  return [...args, '-c.extraMetadata.version=' + version]
}
if (require.main === module) {
  try {
    const args = builderArguments(process.argv.slice(2))
    verifyRenderer(path.join(__dirname, '../dist'), 'desktop')
    const result = spawnSync(process.execPath, [require.resolve('electron-builder/cli.js'), ...args], { cwd: __dirname, env: process.env, stdio: 'inherit' })
    if (result.error) throw result.error
    process.exitCode = result.status ?? 1
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { builderArguments }
