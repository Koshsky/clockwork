'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

async function loadProfile(userData) {
  const filename = path.join(userData, 'desktop-service.json')
  await fs.mkdir(userData, { recursive: true })
  try {
    const file = await fs.open(filename, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ version: 1, id: randomUUID() }) + '\n')
      await file.sync()
    } finally { await file.close() }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const stat = await fs.lstat(filename)
  if (!stat.isFile() || stat.size > 1024) throw new Error('Invalid desktop profile metadata')
  const profile = JSON.parse(await fs.readFile(filename, 'utf8'))
  if (profile.version !== 1 || typeof profile.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(profile.id)) throw new Error('Invalid desktop profile metadata')
  return profile.id
}

module.exports = { loadProfile }
