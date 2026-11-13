'use strict'
const routes = require('./api-routes.json')
const { createHash } = require('node:crypto')
const kinds = new Map([
  ['POST /project', 'project'], ['PUT /project/{id}', 'project'], ['DELETE /project/{id}', 'project'],
  ['POST /process', 'process'], ['PUT /process/{id}', 'process'], ['DELETE /process/{id}', 'process'], ['PUT /process/order', 'reorder'],
  ['POST /task', 'task'], ['PUT /task/{id}', 'task'], ['DELETE /task/{id}', 'task'], ['PUT /task/order', 'reorder'],
  ['POST /milestone', 'milestone'], ['PUT /milestone/{id}', 'milestone'], ['DELETE /milestone/{id}', 'milestone'],
  ['POST /assignment', 'assignment'], ['PUT /assignment/{id}', 'assignment'], ['DELETE /assignment/{id}', 'assignment'],
  ['POST /resources', 'resource'], ['PUT /resources/{id}', 'resource'], ['DELETE /resources/{id}', 'resource'],
  ['POST /resources/{id}/members', 'member'], ['DELETE /resources/{id}/members/{userId}', 'member'],
  ['POST /timesheet/states', 'state'], ['PUT /timesheet/states/{id}', 'state'], ['DELETE /timesheet/states/{id}', 'state'],
  ['PUT /user/{id}/days', 'period'], ['DELETE /user/{id}/days', 'period'],
  ['POST /task/{id}/dependencies', 'dependency'], ['PUT /task/{id}/dependencies/{dep_id}', 'dependency'], ['DELETE /task/{id}/dependencies/{dep_id}', 'dependency'],
])
const record = value => value && typeof value === 'object' && !Array.isArray(value)
function validMutation(value) {
  if (!record(value) || Object.keys(value).some(key => !['route', 'path', 'query', 'body', 'tempId', 'locale', 'preconditions'].includes(key)) || !kinds.has(value.route)) return false
  if (value.preconditions != null && (!record(value.preconditions) || Object.keys(value.preconditions).length > 128 || Object.entries(value.preconditions).some(([key, token]) => !/^(states|(?:project|process|resource|user_days):-?[1-9]\d*)$/.test(key) || typeof token !== 'string' || !token || token.length > 256))) return false
  const route = routes.find(item => item.operation === value.route)
  const names = [...route.path.matchAll(/\{([^}]+)\}/g)].map(item => item[1])
  const params = value.path ?? {}, query = value.query ?? {}
  if (!record(params) || !record(query) || Object.keys(params).some(key => !names.includes(key)) || names.some(key => !/^-?[1-9]\d*$/.test(String(params[key])) || !Number.isSafeInteger(Number(params[key])))) return false
  if (Object.keys(query).some(key => !route.query.includes(key) || !['string', 'number', 'boolean'].includes(typeof query[key]))) return false
  return (value.tempId == null || Number.isSafeInteger(value.tempId) && value.tempId < 0) && (value.locale == null || ['ru', 'en'].includes(value.locale)) && (value.body == null || record(value.body))
}
function requestPath(input) {
  const route = routes.find(item => item.operation === input.route)
  if (!route || !validMutation(input)) throw new Error('COMMAND_INVALID_REQUEST')
  let path = route.path
  for (const [key, value] of Object.entries(input.path || {})) path = path.replace('{' + key + '}', encodeURIComponent(String(value)))
  const query = new URLSearchParams(Object.entries(input.query || {}).map(([key, value]) => [key, String(value)]))
  return '/api/v1' + path + (query.size ? '?' + query : '')
}
function entryOf(input, operationId, ts) {
  const route = routes.find(item => item.operation === input.route)
  const body = input.body ? Object.fromEntries(Object.entries(input.body).filter(([key]) => key !== '_preconditions')) : undefined
  return { id: operationId, idempotencyKey: operationId, method: route.method, url: requestPath({ ...input, tempId: undefined }), body, entity: kinds.get(input.route), tempId: input.tempId, ts }
}
function requestHash(body) {
  const type = Buffer.from('application/json'), length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(type.length))
  return createHash('sha256').update(length).update(type).update(body === undefined ? '' : JSON.stringify(body)).digest('hex')
}
function unwrap(result) {
  const value = result?.data?.data
  return value && record(value) && Object.hasOwn(value, 'snapshot') && record(value._revisions)
    ? { result: { ...result, data: { ...result.data, data: value.snapshot } }, revisions: value._revisions }
    : { result, revisions: {} }
}
module.exports = { validMutation, requestPath, entryOf, requestHash, unwrap, kinds }
