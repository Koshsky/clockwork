'use strict'

const { readFileSync } = require('node:fs')
const path = require('node:path')

function readVersion(directory = path.join(__dirname, '..'), expected = process.env.APP_VERSION) {
  const { version } = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
  if (typeof version !== 'string' || version !== version.trim() || version.length > 127 || !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version)) throw new Error('Invalid frontend version: expected stable SemVer X.Y.Z in package.json')
  if (expected && expected !== version) throw new Error('APP_VERSION must match frontend/package.json')
  return version
}
if (require.main === module) {
  try { console.log(readVersion()) } catch (error) { console.error(error.message); process.exitCode = 1 }
}
module.exports = { readVersion }
