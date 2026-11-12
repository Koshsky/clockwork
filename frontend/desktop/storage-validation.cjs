'use strict'

const { validate, bounded, readOperations } = require('./protocol.cjs')
const { normalizeServer } = require('./session-service.cjs')
const { createHash } = require('node:crypto')
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const statuses = ['queued', 'unknown', 'confirmed', 'rejected', 'conflict']
const secret = /^(password|passwordhash|oldpassword|newpassword|accesstoken|refreshtoken|authorization|access|refresh|token|bearertoken|jwtsecret|jwtrefresh|jwtsecretkey|jwtrefreshkey)$/
class StorageError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireValue(condition, code = 'STORAGE_INVALID_INPUT') { if (!condition) throw new StorageError(code) }
function safeJSON(value, maxBytes = 8 * 1024 * 1024) {
  requireValue(value !== undefined && bounded(value, maxBytes))
  function visit(part) {
    if (part && typeof part === 'object') for (const [key, child] of Object.entries(part)) {
      requireValue(!secret.test(key.replace(/[_-]/g, '').toLowerCase()), 'STORAGE_SECRET_NOT_ALLOWED')
      visit(child)
    }
  }
  visit(value)
  return JSON.stringify(value)
}
function settingsKey(key) {
  requireValue(identifier(key))
  requireValue(!secret.test(key.replace(/^mvs_erp_/i, '').replace(/[_-]/g, '').toLowerCase()), 'STORAGE_SECRET_NOT_ALLOWED')
}
function scopeOf(value) {
  requireValue(value && Object.keys(value).every(key => ['server', 'accountId'].includes(key)) && Number.isSafeInteger(value.accountId) && value.accountId > 0)
  try { return { server: normalizeServer(value.server), accountId: value.accountId } } catch { throw new StorageError('STORAGE_INVALID_SCOPE') }
}
function snapshotKey(domain, key) { requireValue(readOperations.includes(domain) && identifier(key)) }
function changesOf(value) {
  requireValue(Array.isArray(value) && value.length <= 128)
  const seen = new Set()
  return value.map(change => {
    requireValue(change && Object.keys(change).every(key => ['domain', 'key', 'data', 'expectedRevision'].includes(key)))
    snapshotKey(change.domain, change.key)
    requireValue(Number.isSafeInteger(change.expectedRevision) && change.expectedRevision >= 0)
    const identity = JSON.stringify([change.domain, change.key]); requireValue(!seen.has(identity)); seen.add(identity)
    return { ...change, json: safeJSON(change.data) }
  })
}
function localCommand(value) {
  requireValue(value && Object.keys(value).every(key => ['operationId', 'operation', 'input', 'idempotencyKey', 'dependencies', 'changes'].includes(key)))
  requireValue(identifier(value.operationId) && identifier(value.idempotencyKey))
  requireValue(typeof value.operation === 'string' && !/^(account|comment|rbac|template)\./.test(value.operation))
  requireValue(validate({ protocol: 1, kind: 'command', contextId: 'storage', requestId: 'storage', operationId: value.operationId, operation: value.operation, input: value.input }))
  const dependencies = value.dependencies ?? []
  requireValue(Array.isArray(dependencies) && dependencies.length <= 128 && dependencies.every(identifier) && new Set(dependencies).size === dependencies.length && !dependencies.includes(value.operationId))
  const input = safeJSON(value.input ?? null, 1024 * 1024)
  return { ...value, input, dependencies, changes: changesOf(value.changes ?? []), digest: digest([value.operation, JSON.parse(input), value.idempotencyKey, [...dependencies].sort()]) }
}
function digest(value) {
  const canonical = JSON.stringify(value, (_, part) => part && typeof part === 'object' && !Array.isArray(part) ? Object.fromEntries(Object.entries(part).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : part)
  return createHash('sha256').update(canonical).digest('hex')
}
function storageFailure(error) {
  if (error instanceof StorageError) return error.code
  if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return 'STORAGE_READ_ONLY'
  if (error?.code === 'ENOSPC') return 'STORAGE_FULL'
  const code = Number(error?.errcode) & 255
  return ({ 5: 'STORAGE_BUSY', 6: 'STORAGE_BUSY', 8: 'STORAGE_READ_ONLY', 10: 'STORAGE_IO_ERROR', 11: 'STORAGE_CORRUPT', 13: 'STORAGE_FULL', 14: 'STORAGE_CANNOT_OPEN', 19: 'STORAGE_CONFLICT', 26: 'STORAGE_CORRUPT' })[code] || 'STORAGE_UNAVAILABLE'
}
module.exports = { StorageError, requireValue, safeJSON, scopeOf, snapshotKey, changesOf, localCommand, digest, identifier, statuses, settingsKey, storageFailure }
