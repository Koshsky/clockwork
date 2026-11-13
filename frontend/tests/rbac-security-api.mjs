import { expect } from 'playwright/test'
import { randomUUID } from 'node:crypto'
const api = process.env.ERP_TEST_API, password = process.env.ERP_TEST_PASSWORD
if (process.env.ERP_TEST_ISOLATED !== '1' || !password || !api || !['127.0.0.1', 'localhost'].includes(new URL(api).hostname)) throw new Error('An isolated local security API is required')
const prefix = 'sec' + randomUUID().slice(0, 8), cleanup = [], dates = { start_date: '2026-11-01', end_date: '2026-11-30' }
let admin, actor, actorId, checks = 0
async function call(token, method, route, body) {
 for (let attempt = 0; attempt < 8; attempt++) {
  const response = await fetch(api + '/api/v1' + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (response.status === 429) { await new Promise(resolve => setTimeout(resolve, 1000)); continue }
  return { status: response.status, ...(response.status === 204 ? {} : await response.json()) }
 }
 throw new Error('Security API rate limit did not recover')
}
async function create(route, body) {
 const result = await call(admin, 'POST', route, body); expect(result.status, 'fixture ' + route).toBe(201)
 cleanup.push(() => call(admin, 'DELETE', route + '/' + result.data.id)); return result.data
}
function check(actual, expected, label) { expect(actual, label).toEqual(expected); checks++ }
function denied(result, label) { expect([403, 404], label).toContain(result.status); checks++ }
try {
 const login = await call(null, 'POST', '/auth/login', { username: 'admin', password }); check(login.status, 200, 'administrator login'); admin = login.data.access_token
 const account = await call(admin, 'POST', '/user', { username: prefix, first_name: 'Security', last_name: 'Fixture', preset: 'worker' }); check(account.status, 201, 'subject'); actorId = account.data.user.id
 cleanup.push(() => call(admin, 'DELETE', '/user/' + actorId))
 const grants = ['project', 'process', 'task', 'milestone', 'assignment', 'resource'].flatMap(resource => ['view', 'create', 'update', 'delete'].map(action => ({ resource, action, scope: ['project', 'resource'].includes(resource) ? 'self' : 'up1', granted: true })))
 check((await call(admin, 'PUT', '/rbac/users/' + actorId + '/permissions', { overrides: grants })).status, 200, 'scoped permissions')
 const authenticated = await call(null, 'POST', '/auth/login', { username: prefix, password: account.data.password }); actor = authenticated.data.access_token
 const ownProject = await create('/project', { ...dates, code: prefix + 'own', owner_id: actorId }), foreignProject = await create('/project', { ...dates, code: prefix + 'foreign', owner_id: login.data.user.id })
 const ownProcess = await create('/process', { ...dates, project_id: ownProject.id, title: prefix + 'own', owner_id: actorId }), foreignProcess = await create('/process', { ...dates, project_id: foreignProject.id, title: prefix + 'foreign', owner_id: login.data.user.id })
 const ownTask = await create('/task', { ...dates, process_id: ownProcess.id, title: prefix + 'own', owner_id: actorId }), foreignTask = await create('/task', { ...dates, process_id: foreignProcess.id, title: prefix + 'foreign', owner_id: login.data.user.id })
 const ownMilestone = await create('/milestone', { process_id: ownProcess.id, title: prefix + 'own', content: prefix, date: '2026-11-15' }), foreignMilestone = await create('/milestone', { process_id: foreignProcess.id, title: prefix + 'foreign', content: prefix, date: '2026-11-15' })
 const ownResource = await create('/resources', { code: prefix + 'own', title: prefix + 'own', owner_id: actorId }), foreignResource = await create('/resources', { code: prefix + 'foreign', title: prefix + 'foreign', owner_id: login.data.user.id })
 const ownAssignment = await create('/assignment', { task_id: ownTask.id, resource_id: ownResource.id, quantity: 1 }), foreignAssignment = await create('/assignment', { task_id: foreignTask.id, resource_id: foreignResource.id, quantity: 1 })
 for (const [route, own, foreign, patch] of [['/project', ownProject, foreignProject, { code: prefix + 'tampered' }], ['/process', ownProcess, foreignProcess, { title: 'tampered' }], ['/task', ownTask, foreignTask, { title: 'tampered' }], ['/milestone', ownMilestone, foreignMilestone, { title: 'tampered' }], ['/resources', ownResource, foreignResource, { title: 'tampered' }], ['/assignment', ownAssignment, foreignAssignment, { quantity: 7 }]]) {
  check((await call(actor, 'GET', route + '/' + own.id)).status, 200, 'own direct read ' + route)
  denied(await call(actor, 'GET', route + '/' + foreign.id), 'foreign direct read ' + route)
  if (route !== '/assignment') denied(await call(actor, 'PUT', route + '/' + foreign.id, patch), 'foreign direct update ' + route)
  denied(await call(actor, 'DELETE', route + '/' + foreign.id), 'foreign direct delete ' + route)
  check((await call(admin, 'GET', route + '/' + foreign.id)).status, 200, 'denied delete preserves object ' + route)
 }
 const expandedView = grants.map(rule => rule.resource === 'project' && rule.action === 'view' ? { ...rule, scope: 'all' } : rule)
 check((await call(admin, 'PUT', '/rbac/users/' + actorId + '/permissions', { overrides: expandedView })).status, 200, 'expand viewing without expanding management')
 for (const [route, object] of [['/project', foreignProject], ['/process', foreignProcess], ['/task', foreignTask], ['/milestone', foreignMilestone], ['/assignment', foreignAssignment]]) check((await call(actor, 'GET', route + '/' + object.id)).status, 200, 'inherited parent view ' + route)
 for (const [route, object] of [['/process', foreignProcess], ['/task', foreignTask], ['/milestone', foreignMilestone]]) denied(await call(actor, 'PUT', route + '/' + object.id, { title: 'tampered' }), 'inherited view grants no update ' + route)
 denied(await call(actor, 'DELETE', '/project/' + foreignProject.id), 'all viewing grants no foreign project deletion')
 denied(await call(actor, 'DELETE', '/assignment/' + foreignAssignment.id), 'all viewing grants no foreign assignment deletion')
 denied(await call(actor, 'POST', '/process', { ...dates, project_id: foreignProject.id, title: prefix + 'visible-parent', owner_id: actorId }), 'visible foreign project does not grant process creation')
 denied(await call(actor, 'POST', '/task', { ...dates, process_id: foreignProcess.id, title: prefix + 'visible-parent', owner_id: actorId }), 'visible foreign process does not grant task creation')
 denied(await call(actor, 'POST', '/milestone', { process_id: foreignProcess.id, title: prefix + 'visible-parent', content: prefix, date: '2026-11-15' }), 'visible foreign process does not grant milestone creation')
 denied(await call(actor, 'POST', '/assignment', { task_id: foreignTask.id, resource_id: foreignResource.id, quantity: 3 }), 'visible foreign task does not grant resource assignment')
 check((await call(admin, 'PUT', '/rbac/users/' + actorId + '/permissions', { overrides: grants })).status, 200, 'restore owned view for list checks')
 const listing = await call(actor, 'GET', '/resources?limit=500'); check(listing.status, 200, 'scoped resource listing'); check(listing.data.items.every(row => row.owner_id === actorId), true, 'listing owner isolation')
 for (const route of ['/planning/projects', '/planning/processes', '/planning/tasks']) {
  const result = await call(actor, 'GET', route); check(result.status, 200, 'planning read ' + route)
  check(JSON.stringify(result.data).includes(prefix + 'foreign'), false, 'foreign planning excluded ' + route)
 }
 denied(await call(actor, 'POST', '/project', { ...dates, code: prefix + 'spoofed', owner_id: login.data.user.id }), 'project owner spoofing')
 denied(await call(actor, 'POST', '/resources', { code: prefix + 'spoofed', title: prefix, owner_id: login.data.user.id }), 'resource owner spoofing')
 denied(await call(actor, 'POST', '/process', { ...dates, project_id: foreignProject.id, title: prefix + 'spoofed', owner_id: actorId }), 'foreign project parent')
 denied(await call(actor, 'POST', '/task', { ...dates, process_id: foreignProcess.id, title: prefix + 'spoofed', owner_id: actorId }), 'foreign process parent')
 denied(await call(actor, 'POST', '/milestone', { process_id: foreignProcess.id, title: prefix + 'spoofed', content: prefix, date: '2026-11-15' }), 'foreign milestone parent')
 for (const token of [actor, admin]) {
  const mismatch = await call(token, 'POST', '/assignment', { task_id: ownTask.id, resource_id: foreignResource.id, quantity: 1 })
  expect([400, 403, 409, 422], 'resource/process owner mismatch remains forbidden including admin').toContain(mismatch.status); checks++
 }
 const additionalTask = await create('/task', { ...dates, process_id: ownProcess.id, title: prefix + 'additional', owner_id: actorId })
 const another = await call(actor, 'POST', '/assignment', { task_id: additionalTask.id, resource_id: ownResource.id, quantity: 2 }); check(another.status, 201, 'permitted resource assignment')
 if (another.status === 201) cleanup.push(() => call(admin, 'DELETE', '/assignment/' + another.data.id))
 check((await call(admin, 'PUT', '/resources/' + ownResource.id, { owner_id: login.data.user.id })).status, 200, 'resource ownership transfer')
 check((await call(admin, 'GET', '/assignment/' + ownAssignment.id)).status, 404, 'ownership transfer deletes incompatible assignment')
 check((await call(admin, 'PUT', '/rbac/users/' + actorId + '/permissions', { overrides: [] })).status, 200, 'permissions revoked')
 for (const route of ['/project/' + ownProject.id, '/process/' + ownProcess.id, '/task/' + ownTask.id, '/milestone/' + ownMilestone.id, '/resources/' + ownResource.id]) denied(await call(actor, 'GET', route), 'revoked direct read ' + route)
 for (const route of ['/resources?limit=500', '/planning/projects', '/planning/processes', '/planning/tasks']) denied(await call(actor, 'GET', route), 'revoked list ' + route)
 denied(await call(actor, 'POST', '/resources', { code: prefix + 'denied', title: prefix, owner_id: actorId }), 'revoked create')
 console.log('PASS security RBAC API:', checks, 'assertions; direct IDs, CRUD, parents, owner invariant, revocation and listing isolation')
} finally {
 const failures = []
 for (const undo of cleanup.reverse()) { const result = await undo(); if (![200, 204, 404].includes(result.status)) failures.push(result.status) }
 if (failures.length) throw new Error('Security fixture cleanup failed: ' + failures.join(','))
}
