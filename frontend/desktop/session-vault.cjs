'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

// The file contains public profile metadata and OS-encrypted refresh credentials.
// An interrupted rotation never leaves a replayable old credential on disk.
function createSessionVault(directory, safeStorage, { timeoutMs = 5000 } = {}) {
  const filename = path.join(directory, 'sessions.json')
  let data = { version: 1, servers: {} }, tail = Promise.resolve()
  async function deadline(operation) {
    let timer
    try {
      return await Promise.race([Promise.resolve().then(operation), new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) })])
    } finally { clearTimeout(timer) }
  }
  async function available() {
    try {
      if (safeStorage?.getSelectedStorageBackend?.() === 'basic_text') return false
      const ready = safeStorage?.isAsyncEncryptionAvailable ? await deadline(() => safeStorage.isAsyncEncryptionAvailable()) : Boolean(safeStorage?.isEncryptionAvailable())
      return ready && safeStorage?.getSelectedStorageBackend?.() !== 'basic_text'
    } catch { return false }
  }
  return {
    async load() {
      try {
        const parsed = JSON.parse(await fs.readFile(filename, 'utf8'))
        if (parsed.version !== 1 || !parsed.servers || typeof parsed.servers !== 'object' || Array.isArray(parsed.servers)) throw new Error('Unsupported session vault')
        data = parsed
      } catch (error) { if (error.code !== 'ENOENT') throw new Error('Session vault is unreadable') }
    },
    get(server) { return structuredClone(data.servers[server] || {}) },
    async encrypt(token) {
      if (!await available()) return null
      try {
        const encrypted = safeStorage.encryptStringAsync ? await deadline(() => safeStorage.encryptStringAsync(token)) : safeStorage.encryptString(token)
        return encrypted ? Buffer.from(encrypted).toString('base64') : null
      } catch { return null }
    },
    async decrypt(cipher) {
      if (!cipher || !await available()) return null
      try {
        const input = Buffer.from(cipher, 'base64')
        if (!safeStorage.decryptStringAsync) return safeStorage.decryptString(input)
        const result = await deadline(() => safeStorage.decryptStringAsync(input))
        return typeof result === 'string' ? result : result?.result || null
      } catch { return null }
    },
    put(server, record) {
      const copy = structuredClone(record)
      const write = async () => {
        const next = { version: 1, servers: { ...data.servers, [server]: copy } }
        await fs.mkdir(directory, { recursive: true })
        const temp = filename + '.' + randomUUID()
        try {
          const handle = await fs.open(temp, 'wx', 0o600)
          try { await handle.writeFile(JSON.stringify(next)); await handle.sync() } finally { await handle.close() }
          await fs.rename(temp, filename)
          if (process.platform !== 'win32') {
            const parent = await fs.open(directory, 'r')
            try { await parent.sync() } finally { await parent.close() }
          }
          data = next
        } finally { await fs.rm(temp, { force: true }) }
      }
      const pending = tail.then(write)
      tail = pending.catch(() => {})
      return pending
    },
  }
}
module.exports = { createSessionVault }
