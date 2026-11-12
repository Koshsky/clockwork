'use strict'

const fs = require('node:fs')
const path = require('node:path')

function payloadFiles(root, relative = '') {
  const files = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (entry.name === '.gitkeep') continue
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) files.push(...payloadFiles(root, name))
    else if (entry.isFile()) files.push(name)
    else throw new Error(`Unsupported payload entry: ${name}`)
  }
  return files.sort()
}

function verifyWeb(source, packaged) {
  const expected = new Set(payloadFiles(source))
  const actual = new Set(payloadFiles(packaged))
  const differences = []
  for (const name of expected) {
    if (!actual.has(name)) differences.push(`Missing: ${name}`)
    else if (!fs.readFileSync(path.join(source, name)).equals(fs.readFileSync(path.join(packaged, name)))) {
      differences.push(`Changed: ${name}`)
    }
  }
  for (const name of actual) {
    if (!expected.has(name)) differences.push(`Unexpected: ${name}`)
  }
  return differences
}

module.exports = { verifyWeb }

if (require.main === module) {
  try {
    const [source, packaged] = process.argv.slice(2)
    if (!source || !packaged) throw new Error('Usage: verify-web.cjs <fresh-dist> <packaged-web>')
    const differences = verifyWeb(source, packaged)
    if (differences.length) {
      console.error(differences.slice(0, 20).join('\n'))
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
