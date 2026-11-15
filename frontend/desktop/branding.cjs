'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { DEFAULT_BRANDING, CONFIG_LIMIT, createBrandingReporter, loadBranding, normalizeBranding, readBrandingResponse } = require('./command-branding.cjs')

const CACHE_ENTRIES = 8
const CACHE_FILE = /^branding-[a-f0-9]{64}\.json$/

async function pruneCache(directory, current) {
  const entries = []
  for (const name of await fs.readdir(directory)) {
    if (CACHE_FILE.test(name)) {
      const file = path.join(directory, name), stat = await fs.lstat(file)
      if (stat.isFile() && file !== current) entries.push({ file, modified: stat.mtimeMs })
    } else if (name.endsWith('.tmp') && CACHE_FILE.test(name.slice(0, -4))) await fs.unlink(path.join(directory, name))
  }
  entries.sort((a, b) => b.modified - a.modified || a.file.localeCompare(b.file))
  for (const entry of entries.slice(CACHE_ENTRIES - 1)) await fs.unlink(entry.file)
}

function createBrandingProvider({ directory, server, fetch: fetchRequest, report, now = Date.now }) {
  const pending = new Map()
  const diagnostic = createBrandingReporter(report, now)
  let writes = Promise.resolve()
  return async () => {
    const selected = server()
    if (!selected) return { ...DEFAULT_BRANDING }
    const origin = new URL(selected).origin
    if (pending.has(origin)) return pending.get(origin).promise
    // Every window uses the same selected server; superseded reads cannot help it.
    for (const [previous, request] of pending) {
      request.controller.abort('branding-server-changed')
      pending.delete(previous)
    }
    const file = path.join(directory, 'branding-' + createHash('sha256').update(origin).digest('hex') + '.json')
    const controller = new AbortController()
    const reportIssue = code => { if (controller.signal.reason !== 'branding-server-changed') diagnostic(code) }
    const flight = (async () => {
      const timeout = setTimeout(() => controller.abort(), 2500)
      try {
        const branding = await loadBranding(async (pathname, limit) => {
          const response = await fetchRequest(origin + pathname, { signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' })
          return readBrandingResponse(response, limit)
        }, reportIssue)
        controller.signal.throwIfAborted()
        writes = writes.then(async () => {
          const temporary = file + '.tmp'
          try {
            controller.signal.throwIfAborted()
            await pruneCache(directory, file)
            await fs.writeFile(temporary, JSON.stringify(branding), { mode: 0o600 })
            await fs.rename(temporary, file)
          } catch { reportIssue('cache-write-failed') }
          finally { await fs.unlink(temporary).catch(() => {}) }
        })
        await writes
        return branding
      } catch {
        try {
          const stat = await fs.lstat(file)
          if (stat.isFile() && stat.size <= CONFIG_LIMIT) {
            const value = JSON.parse(await fs.readFile(file, 'utf8'))
            const cached = normalizeBranding(value)
            await fs.utimes(file, new Date(now()), new Date(now())).catch(() => {})
            return cached
          }
          diagnostic('invalid-branding-cache')
        } catch (error) { if (error.code !== 'ENOENT') diagnostic('cache-read-failed') }
        return { ...DEFAULT_BRANDING }
      } finally { clearTimeout(timeout) }
    })().finally(() => { if (pending.get(origin)?.promise === flight) pending.delete(origin) })
    pending.set(origin, { promise: flight, controller })
    return flight
  }
}

module.exports = { createBrandingProvider }
