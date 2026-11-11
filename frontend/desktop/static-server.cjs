'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { securityHeaders } = require('./security.cjs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

const IMMUTABLE_EXT = new Set(['.js', '.mjs', '.css', '.ttf', '.woff', '.woff2', '.svg', '.png'])

function normalizePath(webDir, urlPath) {
  // Normalize to the root and strip traversal, but keep "/" → index.html
  const decoded = decodeURIComponent(urlPath)
  const p = path.normalize('/' + decoded).replace(/^\/+/, '')
  const abs = path.join(webDir, p)
  if (!abs.startsWith(webDir + path.sep) && abs !== webDir) {
    return null
  }
  return abs
}

function serveStatic(webDir, req, res) {
  let filePath
  try {
    const url = new URL(req.url, 'http://127.0.0.1')
    filePath = normalizePath(webDir, url.pathname)
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' })
    res.end('Bad request')
    return
  }

  if (filePath == null) {
    res.writeHead(403, { 'Content-Type': 'text/plain' })
    res.end('Forbidden')
    return
  }

  // Resolve the target file: if the path points to a directory (trailing '/' etc.)
  // or does not exist — serve the SPA index.html. readFileSync never
  // receives a directory (otherwise EISDIR).
  let resolved = filePath
  try {
    const st = fs.statSync(resolved)
    if (!st.isFile()) {
      resolved = path.join(webDir, 'index.html')
    }
  } catch {
    resolved = path.join(webDir, 'index.html')
  }

  let data
  try {
    data = fs.readFileSync(resolved)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('Not found')
    return
  }

  const ext = path.extname(resolved).toLowerCase()
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
  }

  // Cache modeled after the frontend nginx config: hashed assets are immutable,
  // index.html/precache-manifest are not cached (always the fresh version).
  const base = path.basename(resolved)
  if (IMMUTABLE_EXT.has(ext) && resolved.startsWith(path.join(webDir, 'assets'))) {
    headers['Cache-Control'] = 'public, max-age=31536000, immutable'
  } else if (base === 'index.html' || base === 'precache-manifest.json') {
    headers['Cache-Control'] = 'no-cache'
  }

  headers['Content-Length'] = data.length
  res.writeHead(200, headers)
  res.end(data)
}

function createStaticHandler(webDir) {
  return (req, res) => {
    // Apply headers before resolving paths so errors and worker scripts have
    // the same policy as the HTML document.
    for (const [name, value] of Object.entries(securityHeaders())) res.setHeader(name, value)
    serveStatic(webDir, req, res)
  }
}

module.exports = { createStaticHandler }
