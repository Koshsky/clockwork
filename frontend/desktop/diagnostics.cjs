'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHmac, randomBytes } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { diagnosticEvent } = require('./command-diagnostics.cjs')
const SOURCES = ['main', 'renderer', 'worker', 'queue', 'sync']
const OUTCOMES = ['observed', 'ready', 'failed', 'stopped', 'queued', 'confirmed', 'conflict', 'rejected', 'unknown', 'receipt_confirmed', 'suspended', 'resumed']
const FILE = /^[a-f0-9]{32}-\d{16}-[a-f0-9]{8}\.jsonl$/
const DEFAULT_LIMIT = 16 * 1024 * 1024, FILE_LIMIT = 1024 * 1024, RETENTION = 7 * 86400000

function project(value, version) {
  try {
    if (!value || !SOURCES.includes(value.source) || !OUTCOMES.includes(value.outcome)) return null
    const input = value.diagnostic || {}
    const diagnostic = diagnosticEvent(input.event, { code: input.error_code, response: { status: input.status, data: { error: { code: input.error_code } } } },
      { platform: 'desktop', version: input.version ?? version, request_id: input.request_id, duration_ms: input.duration_ms })
    const at = Number.isSafeInteger(value.at) && value.at >= 0 && value.at <= 8640000000000000 ? value.at : 0
    return { at, source: value.source, outcome: value.outcome, diagnostic,
      ...(['component', 'window', 'promise', 'chunk', 'navigation', 'api', 'pdf'].includes(value.kind) ? { kind: value.kind } : {}) }
  } catch { return null }
}

function createDiagnostics({ directory, version, now = Date.now, monotonic = () => performance.now(), diskLimit = DEFAULT_LIMIT }) {
  const root = path.join(directory, 'diagnostics')
  const wall = () => { const value = now(); return Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000 ? value : 0 }
  let key, tag = randomBytes(16).toString('hex'), generation = 0, contextId
  let mode = 'available', dropped = 0, memory = [], pending = [], scheduled = false, closed = false, currentFile = null
  let backendVersion
  let activeMs = 0, lastDurationMs = null, pausedAt = null, pausedMs = 0
  const outcomes = {}
  diskLimit = Number.isSafeInteger(diskLimit) && diskLimit > 4096 ? Math.min(diskLimit, DEFAULT_LIMIT) : DEFAULT_LIMIT
  function fail() { mode = 'unavailable'; pending = [] }
  try {
    if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) throw new Error('unsafe')
    fs.mkdirSync(root, { recursive: true, mode: 0o700 })
    fs.chmodSync(root, 0o700)
    const keyFile = path.join(root, 'partition-key')
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
    const info = fs.lstatSync(keyFile)
    if (!info.isFile() || info.isSymbolicLink() || info.size !== 64) throw new Error('unsafe')
    key = fs.readFileSync(keyFile, 'utf8')
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('unsafe')
  } catch { fail() }
  function files() {
    const entries = fs.readdirSync(root)
    if (entries.length > 512) throw new Error('inventory_limit')
    return entries.filter(name => FILE.test(name)).map(name => {
      const filename = path.join(root, name), info = fs.lstatSync(filename)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe')
      return { filename, name, bytes: info.size, time: Number(name.split('-')[1]) }
    }).sort((a, b) => a.time - b.time)
  }
  function prune(extra = 0) {
    const entries = files()
    let remaining = entries.length
    let total = entries.reduce((sum, item) => sum + item.bytes, 64)
    for (const item of entries) {
      if (wall() - item.time <= RETENTION && total + extra <= diskLimit && remaining <= 128) break
      fs.unlinkSync(item.filename); total -= item.bytes; remaining--
      if (item.filename === currentFile) currentFile = null
    }
    if (total + extra > diskLimit) throw new Error('quota')
  }
  try { if (mode === 'available') prune() } catch { fail() }
  function drain() {
    scheduled = false
    if (mode !== 'available') return
    for (let i = 0; i < 16 && pending.length; i++) {
      const item = pending.shift()
      if (item.generation !== generation) continue
      try {
        const line = JSON.stringify(item.value) + '\n', bytes = Buffer.byteLength(line)
        prune(bytes)
        if (!currentFile || fs.lstatSync(currentFile).size + bytes > Math.min(FILE_LIMIT, diskLimit / 2)) {
          currentFile = path.join(root, `${tag}-${String(wall()).padStart(16, '0')}-${randomBytes(4).toString('hex')}.jsonl`)
          fs.writeFileSync(currentFile, '', { flag: 'wx', mode: 0o600 })
        }
        const info = fs.lstatSync(currentFile)
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('unsafe')
        fs.appendFileSync(currentFile, line, { flag: fs.constants.O_WRONLY | fs.constants.O_APPEND | (fs.constants.O_NOFOLLOW || 0), mode: 0o600 })
      } catch { fail(); break }
    }
    if (pending.length && !scheduled) { scheduled = true; setImmediate(drain) }
  }
  function record(source, event, error, metadata, outcome = 'observed', expected = generation) {
    if (closed || expected !== generation) return
    try {
      const value = project({ at: wall(), source, outcome, kind: metadata?.kind,
        diagnostic: diagnosticEvent(event, error, { ...metadata, platform: 'desktop', version }) }, version)
      if (!value || Buffer.byteLength(JSON.stringify(value)) > 2048) return
      if (source === 'queue') outcomes[outcome] = Math.min((outcomes[outcome] || 0) + 1, 1000000000)
      memory = [...memory, value].slice(-50)
      if (mode === 'available') {
        if (pending.length >= 128) { dropped = Math.min(dropped + 1, 1000000000); return }
        pending.push({ value, generation })
        if (!scheduled) { scheduled = true; setImmediate(drain) }
      }
    } catch { /* The business queue never depends on diagnostic storage. */ }
  }
  function setContext(state) {
    const nextId = state?.contextId
    if (nextId === contextId) return
    contextId = nextId; generation++; memory = []; pending = []; currentFile = null
    dropped = 0; backendVersion = undefined; activeMs = 0; lastDurationMs = null
    for (const name of Object.keys(outcomes)) delete outcomes[name]
    try {
      const server = new URL(state.server)
      if (!key || !state.user || !Number.isSafeInteger(state.user.id) || state.mode === 'signedOut'
          || !['https:', 'http:'].includes(server.protocol) || server.username || server.password || server.search || server.hash) throw new Error('no_context')
      tag = createHmac('sha256', key).update(JSON.stringify([server.href.replace(/\/$/, ''), state.user.id])).digest('hex').slice(0, 32)
    } catch { tag = randomBytes(16).toString('hex') }
  }
  function activeNow() { return (pausedAt ?? monotonic()) - pausedMs }
  function beginDelivery() {
    const own = generation, start = activeNow()
    let finished = false
    return (outcome = 'unknown', error, metadata = {}) => {
      if (finished || own !== generation) return
      finished = true
      const duration = Math.max(0, activeNow() - start)
      activeMs += duration; lastDurationMs = duration
      record('queue', 'outbox-send', error, { ...metadata, duration_ms: duration }, outcome)
    }
  }
  const retentionTimer = setInterval(() => { if (mode === 'available') { try { prune() } catch { fail() } } }, 60000)
  retentionTimer.unref?.()
  async function flush() {
    while (pending.length && mode === 'available') { drain(); if (pending.length) await new Promise(resolve => setImmediate(resolve)) }
  }
  async function report() {
    const own = generation
    await flush()
    if (own !== generation) return null
    let records = memory.slice()
    if (mode === 'available') {
      try {
        prune()
        records = []
        for (const file of files().filter(item => item.name.startsWith(tag + '-')).reverse()) {
          if (wall() - file.time > RETENTION || file.bytes > FILE_LIMIT) continue
          const fd = fs.openSync(file.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
          let raw
          try { const buf = Buffer.alloc(Math.min(FILE_LIMIT, file.bytes)); const n = fs.readSync(fd, buf); raw = buf.subarray(0, n).toString('utf8') } finally { fs.closeSync(fd) }
          for (const line of raw.split('\n').reverse()) {
            try { const item = project(JSON.parse(line), version); if (item) records.unshift(item) } catch { /* Never export an unparsed/raw line. */ }
            if (records.length >= 100) break
          }
          if (records.length >= 100) break
        }
      } catch { fail(); records = memory.slice() }
    }
    return { schema: 1, platform: 'desktop', frontend_version: diagnosticEvent('diagnostic', null, { version }).version ?? 'unknown', backend_version: backendVersion ?? 'unknown',
      journal: { status: mode, dropped, disk_limit_bytes: diskLimit, retention_days: 7 },
      delivery: { active_ms_current_session: activeMs, suspended: pausedAt != null, last_duration_ms: lastDurationMs, outcomes: { ...outcomes } }, records }
  }
  return { record, setContext, beginDelivery, report, flush,
    bind(source, event) { const own = generation; return (error, metadata, outcome) => record(source, event, error, metadata, outcome, own) },
    rememberBackendVersion(value, expected) { if (expected !== generation) return; backendVersion = diagnosticEvent('diagnostic', null, { version: typeof value === 'string' ? value.replace(/^v/, '') : undefined }).version },
    contextToken: () => generation,
    suspend() { if (pausedAt == null) pausedAt = monotonic(); record('main', 'runtime-start', null, null, 'suspended') },
    resume() { if (pausedAt != null) { pausedMs += monotonic() - pausedAt; pausedAt = null }; record('main', 'runtime-start', null, null, 'resumed') },
    async close() { clearInterval(retentionTimer); await flush(); closed = true },
  }
}

module.exports = { createDiagnostics, project }
