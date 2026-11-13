'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { constants } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { DatabaseSync, backup } = require('node:sqlite')
const { applicationId, migrations, schemaVersion } = require('./storage-schema.cjs')
const { StorageError, requireValue, safeJSON, scopeOf, snapshotKey, changesOf, localCommand, digest, identifier, settingsKey } = require('./storage-validation.cjs')
const filename = 'clockwork.sqlite'
const backupName = value => typeof value === 'string' && /^(manual|migration)-[0-9a-f-]{36}\.sqlite$/.test(value)
async function privateFile(file) {
  await fs.chmod(file, 0o600)
  const handle = await fs.open(file, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}
async function syncDirectory(directory) {
  if (process.platform === 'win32') return
  const handle = await fs.open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function backupDirectory(directory, create = false) {
  const folder = path.join(directory, 'backups')
  if (create) await fs.mkdir(folder, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(folder)
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'STORAGE_INVALID_BACKUP')
  return folder
}
function verify(db) {
  const app = db.prepare('PRAGMA application_id').get().application_id
  const version = db.prepare('PRAGMA user_version').get().user_version
  requireValue(app === applicationId, 'STORAGE_FOREIGN_DATABASE')
  requireValue(version > 0 && version <= schemaVersion, 'STORAGE_INCOMPATIBLE_VERSION')
  const history = db.prepare('SELECT version, name, checksum FROM storage_migrations ORDER BY version').all()
  requireValue(history.length === version && history.every((entry, index) => entry.version === index + 1 && entry.name === migrations[index]?.name && entry.checksum === migrations[index]?.checksum), 'STORAGE_MIGRATION_MISMATCH')
  const objects = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
  for (const migration of migrations.slice(0, version)) for (const match of migration.sql.matchAll(/CREATE (?:UNIQUE )?(TABLE|INDEX) ([a-z_]+)/g)) requireValue(objects.some(object => object.type === match[1].toLowerCase() && object.name === match[2]), 'STORAGE_CORRUPT')
  requireValue(db.prepare('PRAGMA quick_check').get().quick_check === 'ok', 'STORAGE_CORRUPT')
  requireValue(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'STORAGE_CORRUPT')
  return version
}
async function openStorage(directory, { readOnly = false, onCommit = () => {}, configure } = {}) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.join(directory, filename)
  if (!readOnly) await fs.access(directory, constants.W_OK)
  try { const stat = await fs.lstat(target); requireValue(stat.isFile() && !stat.isSymbolicLink(), 'STORAGE_INVALID_FILE'); if (!readOnly) await fs.access(target, constants.W_OK) } catch (error) { if (error.code !== 'ENOENT') throw error; requireValue(!readOnly, 'STORAGE_READ_ONLY') }
  for (const suffix of ['-wal', '-shm']) {
    try { const stat = await fs.lstat(target + suffix); requireValue(stat.isFile() && !stat.isSymbolicLink(), 'STORAGE_INVALID_FILE') } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const db = new DatabaseSync(target, { readOnly, enableForeignKeyConstraints: true, allowExtension: false })
  let open = true
  const transaction = (run, label) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      onCommit?.('before', label)
      db.exec('COMMIT')
      onCommit?.('after', label)
      return result
    } catch (error) { try { db.exec('ROLLBACK') } catch { /* SQLITE_FULL may have already rolled back. */ } throw error }
  }
  async function makeBackup(kind = 'manual') {
    const folder = await backupDirectory(directory, true), id = `${kind}-${randomUUID()}.sqlite`
    await fs.chmod(folder, 0o700)
    const file = path.join(folder, id)
    const placeholder = await fs.open(file, 'wx', 0o600); await placeholder.close()
    await backup(db, file)
    const check = new DatabaseSync(file)
    try { check.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;'); verify(check) } finally { check.close() }
    await privateFile(file)
    await syncDirectory(folder)
    return { id }
  }
  try {
    db.exec('PRAGMA busy_timeout=1500; PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON;')
    if (!readOnly) {
      db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;')
    }
    const objects = db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all()
    let version = 0
    if (objects.length) version = verify(db)
    else requireValue(db.prepare('PRAGMA application_id').get().application_id === 0 && db.prepare('PRAGMA user_version').get().user_version === 0, 'STORAGE_FOREIGN_DATABASE')
    requireValue(!readOnly || version === schemaVersion, 'STORAGE_INCOMPATIBLE_VERSION')
    if (!readOnly) {
      if (version > 0 && version < schemaVersion) await makeBackup('migration')
      requireValue(db.prepare('PRAGMA journal_mode=WAL').get().journal_mode === 'wal', 'STORAGE_JOURNAL_UNAVAILABLE')
      db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA wal_autocheckpoint=1000;')
      for (const migration of migrations.filter(item => item.version > version)) transaction(() => {
        db.exec(migration.sql)
        db.prepare('INSERT INTO storage_migrations VALUES(?,?,?,?)').run(migration.version, migration.name, migration.checksum, Date.now())
        db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=${migration.version};`)
      }, 'migration-' + migration.version)
      await privateFile(target)
      await syncDirectory(directory)
      for (const suffix of ['-wal', '-shm']) { try { await fs.chmod(target + suffix, 0o600) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    }
    verify(db)
    configure?.(db)
  } catch (error) { db.close(); open = false; throw error }
  const statement = (sql, ...params) => db.prepare(sql).get(...params)
  function scopeId(scope, create = false) {
    const normalized = scopeOf(scope)
    if (create) db.prepare('INSERT INTO scopes(server,account_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(normalized.server, normalized.accountId)
    return statement('SELECT id FROM scopes WHERE server=? AND account_id=?', normalized.server, normalized.accountId)?.id ?? null
  }
  function applyChanges(id, changes) {
    const result = []
    for (const change of changes) {
      const current = statement('SELECT revision FROM snapshots WHERE scope_id=? AND domain=? AND key=?', id, change.domain, change.key)?.revision ?? 0
      requireValue(current === change.expectedRevision, 'STORAGE_STALE_REVISION')
      const revision = current + 1
      requireValue(Number.isSafeInteger(revision), 'STORAGE_REVISION_LIMIT')
      db.prepare('INSERT INTO snapshots VALUES(?,?,?,?,?,?) ON CONFLICT(scope_id,domain,key) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').run(id, change.domain, change.key, revision, change.json, Date.now())
      result.push({ domain: change.domain, key: change.key, revision })
    }
    return result
  }
  function readReceipt(id, operationId) {
    const row = statement('SELECT operation_id,status,result,updated_at FROM receipts WHERE scope_id=? AND operation_id=?', id, operationId)
    return row ? { operationId: row.operation_id, status: row.status, result: row.result == null ? null : JSON.parse(row.result), updatedAt: row.updated_at } : null
  }
  function writable() { requireValue(open, 'STORAGE_CLOSED'); requireValue(!readOnly, 'STORAGE_READ_ONLY') }
  function commitIntent(scope, input, http) {
      writable(); const command = localCommand(input)
      if (http) command.digest = digest([command.operation, JSON.parse(command.input)])
      return transaction(() => {
        const id = scopeId(scope, true)
        const existing = statement('SELECT digest FROM commands WHERE scope_id=? AND operation_id=?', id, command.operationId)
        if (existing) { requireValue(existing.digest === command.digest, 'STORAGE_OPERATION_REUSED'); return { ...readReceipt(id, command.operationId), replayed: true } }
        for (const dependency of command.dependencies) requireValue(statement('SELECT 1 FROM commands WHERE scope_id=? AND operation_id=?', id, dependency), 'STORAGE_MISSING_DEPENDENCY')
        if (http) {
          for (const change of http.changes) cacheChange(id, change)
        }
        const now = Date.now()
        db.prepare('INSERT INTO commands(scope_id,operation_id,operation,input,idempotency_key,digest,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, command.operationId, command.operation, command.input, command.idempotencyKey, command.digest, 'queued', now, now)
        for (const dependency of command.dependencies) db.prepare('INSERT INTO dependencies VALUES(?,?,?)').run(id, command.operationId, dependency)
        applyChanges(id, command.changes)
        for (const change of command.changes) db.prepare('INSERT INTO command_snapshots VALUES(?,?,?,?)').run(id, command.operationId, change.domain, change.key)
        db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?,?)').run(id, command.operationId, 'queued', null, null, now)
        if (http) db.prepare('INSERT INTO command_http(scope_id,operation_id,temp_id) VALUES(?,?,?)').run(id, command.operationId, input.input.tempId ?? null)
        return { ...readReceipt(id, command.operationId), replayed: false }
      }, 'local')
    }
  function cacheChange(id, change) {
    requireValue(change && typeof change.key === 'string' && change.key.length <= 8192 && Number.isSafeInteger(change.expectedRevision) && change.expectedRevision >= 0)
    const row = statement('SELECT revision FROM http_cache WHERE scope_id=? AND key=?', id, change.key)
    requireValue((row?.revision ?? 0) === change.expectedRevision, 'STORAGE_STALE_REVISION')
    const projection = safeJSON(change.projection), baseline = safeJSON(change.baseline), revisions = safeJSON(change.revisions ?? {})
    db.prepare('INSERT INTO http_cache VALUES(?,?,?,?,?,?,?) ON CONFLICT(scope_id,key) DO UPDATE SET revision=excluded.revision,baseline=excluded.baseline,projection=excluded.projection,revisions=excluded.revisions,updated_at=excluded.updated_at').run(id, change.key, change.expectedRevision + 1, baseline, projection, revisions, Date.now())
  }
  const api = {
    info() {
      requireValue(open, 'STORAGE_CLOSED')
      return { driver: 'node:sqlite', sqlite: statement('SELECT sqlite_version() AS version').version, schemaVersion: statement('PRAGMA user_version').user_version, journalMode: statement('PRAGMA journal_mode').journal_mode, synchronous: statement('PRAGMA synchronous').synchronous, readOnly }
    },
    snapshot(scope, { domain, key = 'default' }) {
      snapshotKey(domain, key)
      const row = statement('SELECT revision,data,updated_at FROM snapshots WHERE scope_id=? AND domain=? AND key=?', scopeId(scope), domain, key)
      return row ? { data: JSON.parse(row.data), revision: row.revision, updatedAt: row.updated_at } : null
    },
    saveSnapshot(scope, change) {
      writable(); const changes = changesOf([change])
      return transaction(() => {
        const id = scopeId(scope, true)
        const pending = statement("SELECT 1 FROM command_snapshots cs JOIN commands c USING(scope_id,operation_id) WHERE cs.scope_id=? AND cs.domain=? AND cs.key=? AND c.status!='confirmed' LIMIT 1", id, change.domain, change.key)
        requireValue(!pending, 'STORAGE_PENDING_PROJECTION')
        return applyChanges(id, changes)[0]
      }, 'snapshot')
    },
    commitLocal: (scope, input) => commitIntent(scope, input),
    commitHttp(scope, { operationId, input, dependencies = [], changes = [] }) {
      requireValue(Array.isArray(changes) && changes.length <= 128)
      return commitIntent(scope, { operationId, operation: 'http.mutation', input, idempotencyKey: operationId, dependencies, changes: [] }, { changes })
    },
    queue(scope, { limit = 100, after = 0 } = {}) {
      requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= 200 && Number.isSafeInteger(after) && after >= 0)
      const id = scopeId(scope)
      return db.prepare("SELECT * FROM commands WHERE scope_id=? AND status!='confirmed' AND sequence>? ORDER BY sequence LIMIT ?").all(id, after, limit).map(row => ({
        sequence: row.sequence, operationId: row.operation_id, operation: row.operation, input: JSON.parse(row.input), idempotencyKey: row.idempotency_key, status: row.status, attempts: row.attempts,
        dependencies: db.prepare('SELECT depends_on FROM dependencies WHERE scope_id=? AND operation_id=? ORDER BY depends_on').all(id, row.operation_id).map(item => item.depends_on),
        http: (() => { const meta = statement('SELECT temp_id,wire,retry_at,error,discarded FROM command_http WHERE scope_id=? AND operation_id=?', id, row.operation_id); return meta ? { tempId: meta.temp_id, wire: meta.wire ? JSON.parse(meta.wire) : null, retryAt: meta.retry_at, error: meta.error ? JSON.parse(meta.error) : null, discarded: Boolean(meta.discarded), createdAt: row.created_at } : undefined })(),
        ready: !statement("SELECT 1 FROM dependencies d JOIN commands c ON c.scope_id=d.scope_id AND c.operation_id=d.depends_on WHERE d.scope_id=? AND d.operation_id=? AND c.status!='confirmed' LIMIT 1", id, row.operation_id),
      }))
    },
    receipt(scope, { operationId }) { requireValue(identifier(operationId)); return readReceipt(scopeId(scope), operationId) },
    markAttempt(scope, { operationId }) {
      writable(); requireValue(identifier(operationId))
      return transaction(() => {
        const id = scopeId(scope), row = statement('SELECT status FROM commands WHERE scope_id=? AND operation_id=?', id, operationId)
        requireValue(row && ['queued', 'unknown'].includes(row.status), 'STORAGE_INVALID_TRANSITION')
        requireValue(!statement("SELECT 1 FROM dependencies d JOIN commands c ON c.scope_id=d.scope_id AND c.operation_id=d.depends_on WHERE d.scope_id=? AND d.operation_id=? AND c.status!='confirmed' LIMIT 1", id, operationId), 'STORAGE_DEPENDENCY_NOT_READY')
        db.prepare("UPDATE commands SET status='unknown',attempts=attempts+1,updated_at=? WHERE scope_id=? AND operation_id=?").run(Date.now(), id, operationId)
        db.prepare("UPDATE receipts SET status='unknown',updated_at=? WHERE scope_id=? AND operation_id=?").run(Date.now(), id, operationId)
        return readReceipt(id, operationId)
      }, 'attempt')
    },
    settle(scope, input) {
      writable(); requireValue(input && Object.keys(input).every(key => ['operationId', 'status', 'result', 'mappings', 'changes', 'cacheChanges'].includes(key)) && identifier(input.operationId) && ['confirmed', 'rejected', 'conflict'].includes(input.status))
      const json = safeJSON(input.result ?? null), changes = changesOf(input.changes ?? []), mappings = input.mappings ?? []
      requireValue(Array.isArray(mappings) && mappings.length <= 128 && (input.status === 'confirmed' || mappings.length === 0))
      for (const mapping of mappings) requireValue(mapping && Object.keys(mapping).every(key => ['entity', 'temporaryId', 'realId'].includes(key)) && ['project', 'process', 'task', 'milestone', 'resource', 'assignment', 'state', 'http'].includes(mapping.entity) && Number.isSafeInteger(mapping.temporaryId) && mapping.temporaryId < 0 && Number.isSafeInteger(mapping.realId) && mapping.realId > 0)
      const checksum = digest([input.status, JSON.parse(json), mappings])
      return transaction(() => {
        const id = scopeId(scope), row = statement('SELECT status,settlement_digest FROM receipts WHERE scope_id=? AND operation_id=?', id, input.operationId)
        requireValue(row, 'STORAGE_COMMAND_MISSING')
        if (row.settlement_digest) { requireValue(row.settlement_digest === checksum, 'STORAGE_SETTLEMENT_REUSED'); return readReceipt(id, input.operationId) }
        for (const mapping of mappings) {
          const existing = statement('SELECT real_id FROM idmap WHERE scope_id=? AND entity=? AND temporary_id=?', id, mapping.entity, mapping.temporaryId)
          requireValue(!existing || existing.real_id === mapping.realId, 'STORAGE_ID_MAPPING_CONFLICT')
          db.prepare('INSERT INTO idmap VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING').run(id, mapping.entity, mapping.temporaryId, mapping.realId, input.operationId)
        }
        applyChanges(id, changes)
        requireValue(Array.isArray(input.cacheChanges ?? []) && (input.cacheChanges ?? []).length <= 128)
        for (const change of input.cacheChanges ?? []) cacheChange(id, change)
        db.prepare('UPDATE command_http SET error=? WHERE scope_id=? AND operation_id=?').run(input.status === 'confirmed' ? null : safeJSON({ code: input.result?.data?.error?.code || input.status, message: input.result?.data?.error?.message || input.status }), id, input.operationId)
        db.prepare('UPDATE commands SET status=?,updated_at=? WHERE scope_id=? AND operation_id=?').run(input.status, Date.now(), id, input.operationId)
        db.prepare('UPDATE receipts SET status=?,result=?,settlement_digest=?,updated_at=? WHERE scope_id=? AND operation_id=?').run(input.status, json, checksum, Date.now(), id, input.operationId)
        return readReceipt(id, input.operationId)
      }, 'settlement')
    },
    httpHistory(scope, { path, id, createRoute }) {
      requireValue(typeof path === 'string' && path.length <= 256 && Number.isSafeInteger(Number(id)) && typeof createRoute === 'string')
      return db.prepare("SELECT c.operation_id,c.sequence,r.result FROM commands c JOIN receipts r USING(scope_id,operation_id) LEFT JOIN idmap m ON m.scope_id=c.scope_id AND m.operation_id=c.operation_id AND m.entity='http' WHERE c.scope_id=? AND c.status='confirmed' AND ((json_extract(c.input,'$.path.id')=? AND substr(json_extract(c.input,'$.route'),instr(json_extract(c.input,'$.route'),' ')+1)=?) OR (m.real_id=? AND json_extract(c.input,'$.route')=?)) ORDER BY c.sequence").all(scopeId(scope), String(id), path, Number(id), createRoute).map(row => ({ operationId: row.operation_id, sequence: row.sequence, result: JSON.parse(row.result) }))
    },
    httpIntent(scope, { operationId }) {
      requireValue(identifier(operationId))
      const row = statement('SELECT input FROM commands WHERE scope_id=? AND operation_id=? AND operation=?', scopeId(scope), operationId, 'http.mutation')
      return row ? JSON.parse(row.input) : null
    },
    cacheRead(scope, { key }) {
      requireValue(typeof key === 'string' && key.length <= 8192)
      const row = statement('SELECT * FROM http_cache WHERE scope_id=? AND key=?', scopeId(scope), key)
      return row ? { key, revision: row.revision, baseline: JSON.parse(row.baseline), projection: JSON.parse(row.projection), revisions: JSON.parse(row.revisions), ts: row.updated_at } : null
    },
    cacheKeys(scope) { return db.prepare('SELECT key FROM http_cache WHERE scope_id=? ORDER BY key').all(scopeId(scope)).map(row => row.key) },
    cacheCommit(scope, { changes }) {
      writable(); requireValue(Array.isArray(changes) && changes.length <= 128)
      return transaction(() => { const id = scopeId(scope, true); for (const change of changes) cacheChange(id, change); return null }, 'http-cache')
    },
    freezeHttp(scope, { operationId, wire }) {
      writable(); requireValue(identifier(operationId)); const json = safeJSON(wire, 1024 * 1024)
      return transaction(() => {
        const id = scopeId(scope), row = statement('SELECT wire FROM command_http WHERE scope_id=? AND operation_id=?', id, operationId)
        requireValue(row, 'STORAGE_COMMAND_MISSING')
        if (row.wire) { requireValue(row.wire === json, 'STORAGE_OPERATION_REUSED'); return JSON.parse(row.wire) }
        db.prepare('UPDATE command_http SET wire=? WHERE scope_id=? AND operation_id=?').run(json, id, operationId)
        return wire
      }, 'http-wire')
    },
    deferHttp(scope, { operationId, retryAt, error }) {
      writable(); requireValue(identifier(operationId) && Number.isSafeInteger(retryAt) && retryAt >= 0)
      db.prepare('UPDATE command_http SET retry_at=?,error=? WHERE scope_id=? AND operation_id=?').run(retryAt, safeJSON(error), scopeId(scope), operationId)
      return null
    },
    retryHttp(scope, { operationId }) {
      writable(); requireValue(identifier(operationId))
      return transaction(() => {
        const id = scopeId(scope), row = statement('SELECT status FROM commands WHERE scope_id=? AND operation_id=?', id, operationId)
        requireValue(row && row.status !== 'confirmed', 'STORAGE_INVALID_TRANSITION')
        db.prepare("UPDATE commands SET status='queued' WHERE scope_id=? AND operation_id=?").run(id, operationId)
        db.prepare("UPDATE receipts SET status='queued',settlement_digest=NULL WHERE scope_id=? AND operation_id=?").run(id, operationId)
        db.prepare('UPDATE command_http SET retry_at=0,error=NULL WHERE scope_id=? AND operation_id=? AND discarded=0').run(id, operationId)
        return null
      }, 'http-retry')
    },
    discardHttp(scope, { operationIds, changes = [] }) {
      writable(); requireValue(Array.isArray(operationIds) && operationIds.length <= 200 && operationIds.every(identifier) && Array.isArray(changes) && changes.length <= 128)
      return transaction(() => {
        const id = scopeId(scope)
        for (const operationId of operationIds) {
          const row = statement('SELECT status,attempts FROM commands WHERE scope_id=? AND operation_id=?', id, operationId)
          requireValue(row && row.status !== 'confirmed' && (row.status !== 'unknown' && row.attempts === 0 || ['rejected','conflict'].includes(row.status)), 'STORAGE_OUTCOME_UNKNOWN')
          requireValue(!statement('SELECT 1 FROM dependencies d JOIN command_http h ON h.scope_id=d.scope_id AND h.operation_id=d.operation_id WHERE d.scope_id=? AND d.depends_on=? AND h.discarded=0 AND d.operation_id NOT IN (' + operationIds.map(() => '?').join(',') + ') LIMIT 1', id, operationId, ...operationIds), 'STORAGE_DEPENDENTS_EXIST')
          db.prepare('UPDATE command_http SET discarded=1 WHERE scope_id=? AND operation_id=?').run(id, operationId)
        }
        for (const change of changes) cacheChange(id, change)
        return null
      }, 'http-discard')
    },
    resolveId(scope, { entity, temporaryId }) {
      requireValue(identifier(entity) && Number.isSafeInteger(temporaryId) && temporaryId < 0)
      return statement('SELECT real_id FROM idmap WHERE scope_id=? AND entity=? AND temporary_id=?', scopeId(scope), entity, temporaryId)?.real_id ?? null
    },
    setting(scope, { key }) { settingsKey(key); const row = statement('SELECT value,revision FROM settings WHERE scope_id=? AND key=?', scopeId(scope), key); return row ? { value: JSON.parse(row.value), revision: row.revision } : null },
    saveSetting(scope, { key, value, expectedRevision }) {
      writable(); settingsKey(key); requireValue(Number.isSafeInteger(expectedRevision) && expectedRevision >= 0); const json = safeJSON(value, 65536)
      return transaction(() => {
        const id = scopeId(scope, true), current = statement('SELECT revision FROM settings WHERE scope_id=? AND key=?', id, key)?.revision ?? 0
        requireValue(current === expectedRevision, 'STORAGE_STALE_REVISION')
        requireValue(Number.isSafeInteger(current + 1), 'STORAGE_REVISION_LIMIT')
        db.prepare('INSERT INTO settings VALUES(?,?,?,?) ON CONFLICT(scope_id,key) DO UPDATE SET value=excluded.value,revision=excluded.revision').run(id, key, json, current + 1)
        return { revision: current + 1 }
      }, 'setting')
    },
    backup: () => { writable(); return makeBackup() },
    close() { if (open) { db.close(); open = false } },
  }
  return api
}
async function restoreBackup(sourceProfile, id, destinationProfile) {
  requireValue(backupName(id), 'STORAGE_INVALID_BACKUP')
  const folder = await backupDirectory(sourceProfile)
  const source = path.join(folder, id), target = path.join(destinationProfile, filename)
  const stat = await fs.lstat(source); requireValue(stat.isFile() && !stat.isSymbolicLink(), 'STORAGE_INVALID_BACKUP')
  const check = new DatabaseSync(source, { readOnly: true })
  try { verify(check) } finally { check.close() }
  await fs.mkdir(destinationProfile, { recursive: true, mode: 0o700 })
  // Restoring into an empty profile never overwrites a damaged original or WAL.
  for (const suffix of ['', '-wal', '-shm']) { try { await fs.lstat(target + suffix); throw new StorageError('STORAGE_RESTORE_TARGET_EXISTS') } catch (error) { if (error.code !== 'ENOENT') throw error } }
  await fs.copyFile(source, target, require('node:fs').constants.COPYFILE_EXCL)
  await privateFile(target)
  await syncDirectory(destinationProfile)
  return { restored: true }
}
module.exports = { openStorage, restoreBackup, filename, verify }
