'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { DEFAULT_BRANDING, CONFIG_LIMIT, loadBranding, normalizeBranding, readBrandingResponse } = require('./command-branding.cjs')

function createBrandingProvider({ directory, server, fetch: fetchRequest }) {
  const pending = new Map()
  return async () => {
    const selected = server()
    if (!selected) return { ...DEFAULT_BRANDING }
    const origin = new URL(selected).origin
    if (pending.has(origin)) return pending.get(origin)
    if (pending.size >= 4) return { ...DEFAULT_BRANDING }
    const file = path.join(directory, 'branding-' + createHash('sha256').update(origin).digest('hex') + '.json')
    const flight = (async () => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2500)
      try {
        const branding = await loadBranding(async (pathname, limit) => {
          const response = await fetchRequest(origin + pathname, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
          // A removed configuration must clear a previously cached company identity.
          if (response.status === 404 && pathname.endsWith('/config.json')) return new TextEncoder().encode('{}')
          return readBrandingResponse(response, limit)
        })
        const temporary = file + '.tmp'
        try { await fs.writeFile(temporary, JSON.stringify(branding), { mode: 0o600 }); await fs.rename(temporary, file) }
        catch { /* Branding persistence must never block opening the application. */ }
        return branding
      } catch {
        try {
          if ((await fs.stat(file)).size <= CONFIG_LIMIT) return normalizeBranding(JSON.parse(await fs.readFile(file, 'utf8')))
        } catch { /* No cached identity for this server. */ }
        return { ...DEFAULT_BRANDING }
      } finally { clearTimeout(timeout) }
    })().finally(() => pending.delete(origin))
    pending.set(origin, flight)
    return flight
  }
}

module.exports = { createBrandingProvider }
