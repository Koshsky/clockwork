import { request, expect } from 'playwright/test'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')] }))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'shared-groups-' + Date.now(), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const projects = [], users = []
let checks = 0
async function call(token, method, path, data) {
  for (let i = 0; i < 5; i++) {
    const r = await http.fetch(path, { method, data, headers: token ? { Authorization: 'Bearer ' + token } : {} })
    if (r.status() === 429) { await new Promise(resolve => setTimeout(resolve, Math.max(1, Number(r.headers()['retry-after']) || 1) * 1000)); continue }
    const text = await r.text(), body = text ? JSON.parse(text) : {}
    return { status: r.status(), data: body.data, error: body.error }
  }
  throw new Error('API rate limit persisted')
}
function check(actual, expected, name) { expect(actual, name).toEqual(expected); checks++ }
const sorted = ids => ids.sort((a, b) => a - b)
await expect.poll(async () => { try { return (await http.get('health')).status() } catch { return 0 } }, { timeout: 30_000 }).toBe(200)
const login = await call(null, 'POST', 'auth/login', { username: 'admin', password: env.ADMIN_PASSWORD })
check(login.status, 200, 'admin login')
const admin = login.data.access_token, foreign = login.data.user.id
async function create(path, data, token = admin) {
  const r = await call(token, 'POST', path, data)
  check(r.status, 201, path + ' create: ' + JSON.stringify(r.error))
  return r.data.id
}
try {
  for (const scope of (process.env.SHARED_SCOPE ? [process.env.SHARED_SCOPE] : ['sib', 'sib_project'])) {
    const username = 'peer' + (scope === 'sib' ? 'p' : 'j') + Date.now().toString().slice(-8)
    const user = await call(admin, 'POST', 'user', { username, first_name: 'Peer', last_name: 'Test', preset: 'worker', permissions: ['view', 'create', 'update', 'delete'].flatMap(action => [
      { resource: 'task', action, scope, granted: true }, { resource: 'process', action, scope: 'sib', granted: action !== 'view' },
    ]).concat([{ resource: 'project', action: 'view', scope: '', granted: false }]) })
    check(user.status, 201, 'subject create: ' + JSON.stringify(user.error)); const uid = user.data.user.id; users.push(uid)
    const auth = await call(null, 'POST', 'auth/login', { username, password: user.data.password }); check(auth.status, 200, 'subject login')
    const token = auth.data.access_token
    const project = async owner_id => {
      const id = await create('project', { ...dates, code: prefix + '-' + projects.length, owner_id }); projects.push(id)
      // Local auto-create rules populate new projects; isolate the fixture from those templates.
      const generated = []
      for (let offset = 0; ; offset += 500) {
        const r = await call(admin, 'GET', 'process?limit=500&offset=' + offset)
        check(r.status, 200, 'load project auto-created processes')
        generated.push(...r.data.items.filter(p => p.project_id === id).map(p => p.id))
        if (r.data.items.length < 500) break
      }
      for (const processID of generated) check((await call(admin, 'DELETE', 'process/' + processID)).status, 204, 'clear auto-created fixture process')
      return id
    }
    const process = (project_id, owner_id = foreign) => create('process', { ...dates, project_id, owner_id, title: prefix })
    const task = (process_id, owner_id = foreign, parent_id) => create('task', { ...dates, process_id, owner_id, parent_id, title: prefix })
    const a = await project(foreign), b = await project(foreign), c = await project(uid), empty = await project(foreign)
    const a1 = await process(a), a2 = await process(a), b1 = await process(b, uid), b2 = await process(b), c1 = await process(c)
    const root = await task(a1), otherRoot = await task(a1), ownedSubtask = await task(a1, uid, root), otherSubtask = await task(a1, foreign, otherRoot)
    const acrossProcess = await task(a2), bTask = await task(b1), bOtherTask = await task(b2), cTask = await task(c1)
    const allTasks = [root, otherRoot, ownedSubtask, otherSubtask, acrossProcess, bTask, bOtherTask, cTask]
    const expected = scope === 'sib' ? [root, otherRoot, ownedSubtask, otherSubtask] : [root, otherRoot, ownedSubtask, otherSubtask, acrossProcess]
    const collections = async (visible, label) => {
      const ids = []
      for (let offset = 0; ; offset += 2) {
        const r = await call(token, 'GET', 'task?limit=2&offset=' + offset); check(r.status, 200, label + ' list')
        check(r.data.total, visible.length, label + ' total')
        ids.push(...r.data.items.map(x => x.id)); if (!r.data.items.length) break
      }
      check(sorted(ids), sorted([...visible]), label + ' pagination and no duplicates')
      const planning = await call(token, 'GET', 'planning/tasks'); check(planning.status, 200, label + ' planning')
      const flatten = tasks => tasks.flatMap(t => [t.id, ...flatten(t.subtasks ?? [])])
      check(sorted(planning.data.processes.flatMap(p => flatten(p.tasks ?? []))), sorted([...visible]), label + ' diagram exact task set')
      for (const p of planning.data.processes) for (const d of p.dependencies ?? []) {
        check(visible.includes(d.task_id) && visible.includes(d.depends_on_task_id), true, label + ' dependency endpoints')
      }
    }
    await collections(expected, scope)
    for (const id of allTasks) {
      const visible = expected.includes(id), path = 'task/' + id
      check((await call(token, 'GET', path)).status, visible ? 200 : 404, scope + ' GET ' + id)
      const before = await call(admin, 'GET', path)
      check((await call(token, 'PUT', path, { title: prefix + '-edited' })).status, visible ? 200 : 403, scope + ' PUT ' + id)
      if (!visible) {
        check((await call(token, 'DELETE', path)).status, 403, scope + ' DELETE denied ' + id)
        check((await call(admin, 'GET', path)).data, before.data, 'denied mutation preserves row')
      }
    }
    const created = await create('task', { ...dates, process_id: a1, owner_id: foreign, title: prefix }, token)
    const createdSubtask = await create('task', { ...dates, process_id: a1, parent_id: otherRoot, owner_id: foreign, title: prefix }, token)
    expected.push(created, createdSubtask)
    if (scope === 'sib_project') expected.push(await create('task', { ...dates, process_id: a2, title: prefix, owner_id: foreign }, token))
    else check((await call(token, 'POST', 'task', { ...dates, process_id: a2, title: prefix, owner_id: uid })).status, 403, 'same project cannot bootstrap shared-process scope')
    for (const process_id of [b1, c1]) check((await call(token, 'POST', 'task', { ...dates, process_id, title: prefix, owner_id: uid })).status, 403, 'ancestor ownership and proposed owner cannot bootstrap access')
    await collections(expected, scope + ' after create')

    const setProcessView = async granted => {
      const overrides = ['view','create','update','delete'].flatMap(action => [
        {resource:'task',action,scope,granted:true},
        {resource:'process',action,scope:'sib',granted:action !== 'view' || granted},
      ]).concat([{resource:'project',action:'view',scope:'',granted:false}])
      check((await call(admin,'PUT','rbac/users/'+uid+'/permissions',{overrides})).status,200,'isolate legacy peer conditions from inherited parent viewing')
    }
    await setProcessView(true)
    const processes = await call(token, 'GET', 'process?limit=1000')
    check(sorted(processes.data.items.map(p => p.id).filter(id => [a1, a2, b1, b2, c1].includes(id))), sorted([b1, b2]), 'process peers require owned process, not task or project')
    for (const id of [b1, b2]) check((await call(token, 'GET', 'process/' + id)).status, 200, 'own/foreign process direct peer access')
    check((await call(token, 'GET', 'process/' + a1)).status, 404, 'owned task does not grant process peer access')
    const newProcess = await create('process', { ...dates, project_id: b, owner_id: foreign, title: prefix }, token)
    check((await call(token, 'PUT', 'process/' + newProcess, { project_id: empty })).status, 403, 'process peer cannot move to unqualified project')
    check((await call(admin, 'GET', 'process/' + newProcess)).data.project_id, b, 'denied move preserves project')
    check((await call(token, 'DELETE', 'process/' + newProcess)).status, 204, 'delete peer process')
    check((await call(token, 'POST', 'process', { ...dates, project_id: a, title: prefix, owner_id: uid })).status, 403, 'owned task cannot bootstrap process peers')

    await setProcessView(false)
    check((await call(admin, 'PUT', 'task/' + ownedSubtask, { owner_id: foreign })).status, 200, 'remove last task anchor')
    await collections([], scope + ' anchor revoked')
    for (const action of ['GET', 'PUT', 'DELETE']) check((await call(token, action, 'task/' + otherSubtask, action === 'PUT' ? { title: 'denied' } : undefined)).status, action === 'GET' ? 404 : 403, 'lost anchor ' + action)
    check((await call(token, 'POST', 'task', { ...dates, process_id: a1, title: prefix, owner_id: uid })).status, 403, 'cannot restore anchor through unauthorized create')
    check((await call(admin, 'PUT', 'task/' + ownedSubtask, { owner_id: uid })).status, 200, 'restore task anchor')
    await collections(expected, scope + ' anchor restored')
    check((await call(token, 'DELETE', 'task/' + otherSubtask)).status, 204, scope + ' DELETE allowed')
    expected.splice(expected.indexOf(otherSubtask), 1)
    await collections(expected, scope + ' after delete')
    check((await call(token, 'DELETE', 'task/' + ownedSubtask)).status, 204, 'delete last owned task itself')
    await collections([], scope + ' last anchor deleted')
    console.log('PASS ' + scope + ': list/count/pagination, exact diagram, direct GET/PUT/DELETE, create/subtask, owner forgery, dynamic anchor revoke/restore/delete; process peers and denied reparenting')
  }
  console.log('PASS shared groups: ' + checks + ' assertions')
} finally {
  for (const id of projects) await call(admin, 'DELETE', 'project/' + id)
  for (const id of users) await call(admin, 'DELETE', 'user/' + id)
  await http.dispose()
}
