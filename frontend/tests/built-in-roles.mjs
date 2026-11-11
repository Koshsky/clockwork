import { request, expect } from 'playwright/test'
import fs from 'node:fs'
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter(l => /^[A-Z_]+=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^['"]|['"]$/g, '')] }))
const http = await request.newContext({ baseURL: 'http://127.0.0.1:8080/api/v1/' })
const prefix = 'built-in-roles-' + Date.now(), dates = { start_date: '2026-11-01', end_date: '2026-12-31' }
const projects = [], users = []
let checks = 0
async function call(token, method, path, data) {
  path = path.replace(/^resource([/?]|$)/, 'resources$1')
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
const resources = []
const tokens = {}, ids = {}
try {
  for (const preset of ['dp', 'rp', 'vp', 'worker']) {
    const username = 'matrix' + preset + Date.now().toString().slice(-8)
    const r = await call(admin, 'POST', 'user', { username, first_name: 'Matrix', last_name: preset, preset })
    check(r.status, 201, preset + ' user'); ids[preset] = r.data.user.id; users.push(ids[preset])
    const a = await call(null, 'POST', 'auth/login', { username, password: r.data.password })
    check(a.status, 200, preset + ' login'); tokens[preset] = a.data.access_token
  }
  const project = async owner_id => {
    const id = await create('project', { ...dates, code: prefix + '-' + projects.length, owner_id }); projects.push(id)
    const generated = await call(admin, 'GET', 'process?limit=500')
    for (const process of generated.data.items.filter(p => p.project_id === id)) await call(admin, 'DELETE', 'process/' + process.id)
    return id
  }
  const process = (project_id, owner_id) => create('process', { ...dates, project_id, owner_id, title: prefix })
  const task = (process_id, owner_id, parent_id) => create('task', { ...dates, process_id, owner_id, parent_id, title: prefix })
  const resource = async owner_id => { const id = await create('resource', { code: prefix + '-r' + resources.length, title: prefix + '-r' + resources.length, owner_id }); resources.push(id); return id }
  const ownProject = await project(ids.rp), foreignProject = await project(foreign), taskOnlyProject = await project(foreign)
  const ownProcess = await process(ownProject, ids.vp), foreignProcess = await process(ownProject, foreign)
  const otherOwnedProcess = await process(foreignProject, ids.vp), otherProcess = await process(foreignProject, ids.rp), taskOnlyProcess = await process(taskOnlyProject, foreign)
  const ownTask = await task(ownProcess, foreign), ownSubtask = await task(ownProcess, foreign, ownTask)
  const foreignTask = await task(foreignProcess, ids.vp), otherTask = await task(otherOwnedProcess, foreign), rpOnlyTask = await task(otherProcess, ids.rp), taskOnlyTask = await task(taskOnlyProcess, ids.vp)
  const vpResource = await resource(ids.vp), foreignResource = await resource(foreign), rpResource = await resource(ids.rp), workerResource = await resource(ids.worker)
  const milestone = (process_id) => create('milestone', { process_id, title: prefix, content: prefix, date: '2026-11-20' })
  const ownMilestone = await milestone(ownProcess), foreignMilestone = await milestone(foreignProcess), otherMilestone = await milestone(otherOwnedProcess)
  const assignment = (task_id, resource_id) => create('assignment', { task_id, resource_id, quantity: 1 })
  const ownAssignment = await assignment(ownTask, vpResource), foreignAssignment = await assignment(foreignTask, foreignResource), otherAssignment = await assignment(otherTask, vpResource)
  const expected = {
    dp: { project: projects, process: [ownProcess, foreignProcess, otherOwnedProcess, otherProcess, taskOnlyProcess], task: [ownTask, ownSubtask, foreignTask, otherTask, rpOnlyTask, taskOnlyTask], milestone: [ownMilestone, foreignMilestone, otherMilestone], assignment: [ownAssignment, foreignAssignment, otherAssignment], resource: resources },
    rp: { project: [ownProject], process: [ownProcess, foreignProcess], task: [ownTask, ownSubtask, foreignTask], milestone: [ownMilestone, foreignMilestone], assignment: [ownAssignment, foreignAssignment], resource: [vpResource, foreignResource, rpResource] },
    vp: { project: [ownProject, foreignProject], process: [ownProcess, foreignProcess, otherOwnedProcess, otherProcess], task: [ownTask, ownSubtask, foreignTask, otherTask, rpOnlyTask], milestone: [ownMilestone, foreignMilestone, otherMilestone], assignment: [ownAssignment, foreignAssignment, otherAssignment], resource: [vpResource] },
    worker: { project: [], process: [], task: [], milestone: [], assignment: [], resource: [] },
  }
  const all = expected.dp
  const flatTasks = tasks => tasks.flatMap(t => [t.id, ...flatTasks(t.subtasks ?? [])])
  for (const role of ['dp', 'rp', 'vp', 'worker']) {
    const token = tokens[role]
    const perms = await call(token, 'GET', 'permissions/me'); check(perms.status, 200, role + ' permissions')
    if (role === 'worker') check(perms.data, [], 'worker zero preset permissions')
    for (const entity of Object.keys(all)) {
      const visible = expected[role][entity]
      const response = await call(token, 'GET', entity + '?limit=500')
      if (role === 'worker') check(response.status, 403, 'worker list denied ' + entity)
      else {
        check(response.status, 200, role + ' list ' + entity)
        check(sorted(response.data.items.filter(x => all[entity].includes(x.id)).map(x => x.id)), sorted([...visible]), role + ' exact list ' + entity)
        if (role !== 'dp' && entity !== 'resource') check(response.data.total, visible.length, role + ' count ' + entity)
      }
      for (const id of all[entity]) check((await call(token, 'GET', entity + '/' + id)).status, visible.includes(id) ? 200 : 404, role + ' direct ' + entity + '/' + id)
    }
    for (const level of ['projects', 'processes', 'tasks']) {
      const r = await call(token, 'GET', 'planning/' + level)
      check(r.status, role === 'worker' ? 403 : 200, role + ' diagram ' + level)
      if (role === 'worker') continue
      const diagramIds = level === 'projects' ? r.data.projects.map(x => x.id) : level === 'processes' ? r.data.projects.flatMap(p => p.processes.map(x => x.id)) : r.data.processes.flatMap(p => flatTasks(p.tasks ?? []))
      const entity = level === 'projects' ? 'project' : level === 'processes' ? 'process' : 'task'
      check(sorted(diagramIds.filter(id => all[entity].includes(id))), sorted([...expected[role][entity]]), role + ' exact diagram ' + level)
      if (level === 'tasks') for (const p of r.data.processes) if (all.process.includes(p.id)) check(typeof p.project_owner_id, 'number', 'task diagram project owner for UI')
    }
    if (role === 'worker') for (const path of ['timesheet/calendar?start_date=2026-11-01&end_date=2026-12-31','user?limit=10','rbac/matrix','user']) check((await call(token, 'GET', path)).status, path === 'rbac/matrix' ? 404 : 403, 'worker no access ' + path)
    const own = role === 'vp' ? [otherOwnedProcess, otherTask, otherMilestone, otherAssignment] : [foreignProcess, foreignTask, foreignMilestone, foreignAssignment]
    for (const [entity,id,patch] of [['project', ownProject, { code: prefix + '-edited' }], ['process',own[0],{ title: prefix + '-edited' }], ['task',own[1],{ title: prefix + '-edited' }], ['milestone',own[2],{ title: prefix + '-edited' }], ['assignment',own[3],{ quantity: 2 }], ['resource',vpResource,{ title: prefix + '-edited' }]]) {
      const allowed = role === 'rp' ? entity !== 'resource' : role === 'vp' ? entity !== 'project' : false
      check((await call(token, 'PUT', entity + '/' + id, patch)).status, allowed ? 200 : 403, role + ' metadata edit ' + entity)
    }
    const newRows = [
      ['project', { ...dates, code: prefix + '-new-' + role, owner_id: ids[role] }, role === 'rp'],
      ['process', { ...dates, project_id: ownProject, title: prefix, owner_id: ids[role] }, role === 'rp' || role === 'vp'],
      ['task', { ...dates, process_id: ownProcess, title: prefix, owner_id: foreign }, role === 'rp' || role === 'vp'],
      ['milestone', { process_id: ownProcess, content: prefix, date: '2026-11-20', title: prefix }, role === 'rp' || role === 'vp'],
      ['assignment', { task_id: ownSubtask, resource_id: vpResource, quantity: 1 }, role === 'rp' || role === 'vp'],
      ['resource', { code: prefix + '-new-' + role, title: prefix + '-new-' + role, owner_id: ids[role] }, role === 'vp'],
    ]
    for (const [entity,body,allowed] of newRows) {
      const r = await call(token, 'POST', entity, body)
      check(r.status, allowed ? 201 : 403, role + ' create ' + entity + ': ' + JSON.stringify(r.error))
      if (allowed) { check((await call(token,'DELETE',entity+'/'+r.data.id)).status,204,role+' delete '+entity); }
      else check((await call(token,'DELETE',entity+'/'+(entity==='project'?ownProject:entity==='process'?own[0]:entity==='task'?own[1]:entity==='milestone'?own[2]:entity==='assignment'?own[3]:vpResource))).status,403,role+' delete denied '+entity)
    }
  }
  // The director can only send priority, including case-insensitive JSON field spellings.
  for (const body of [{ priority: 7 }, { Priority: 8 }]) check((await call(tokens.dp,'PUT','project/'+ownProject,body)).status,200,'DP priority-only')
  const before = await call(admin,'GET','project/'+ownProject)
  for (const body of [{priority:9,code:'forged'},{priority:9,owner_id:ids.dp},{priority:9,start_date:'2026-01-01'},{priority:9,extra:null},{code:'forged'},{}]) check((await call(tokens.dp,'PUT','project/'+ownProject,body)).status,403,'DP cannot smuggle metadata')
  check((await call(admin,'GET','project/'+ownProject)).data,before.data,'rejected mixed updates are atomic')
  for (const role of ['rp','vp']) {
    const token=tokens[role]
    for (const [entity,id,patch] of [['project',taskOnlyProject,{code:'forged'}],['process',taskOnlyProcess,{title:'forged'}],['task',taskOnlyTask,{title:'forged'}]]) {
      check((await call(token,'PUT',entity+'/'+id,patch)).status,403,role+' cannot edit foreign '+entity)
      check((await call(token,'DELETE',entity+'/'+id)).status,403,role+' cannot delete foreign '+entity)
    }
    check((await call(token,'POST','process',{...dates,project_id:taskOnlyProject,owner_id:ids[role],title:prefix})).status,403,role+' cannot bootstrap process in inaccessible project')
    check((await call(token,'POST','task',{...dates,process_id:taskOnlyProcess,owner_id:ids[role],title:prefix})).status,403,role+' forged owner cannot bootstrap task access')
    check((await call(token,'POST','resource',{code:prefix+'-forged-'+role,title:prefix,owner_id:foreign})).status,403,role+' cannot create foreign resource')
    check((await call(token,'POST','assignment',{task_id:ownSubtask,resource_id:foreignResource,quantity:1})).status,403,role+' assignment owner invariant')
  }
  check((await call(admin,'POST','assignment',{task_id:ownSubtask,resource_id:foreignResource,quantity:1})).status,403,'admin assignment owner invariant')
  for (const [role, rows] of [['vp', [['process',foreignProcess,{title:'forged'}],['task',foreignTask,{title:'forged'}],['milestone',foreignMilestone,{title:'forged'}],['assignment',foreignAssignment,{quantity:2}]]], ['rp', [['process',otherProcess,{title:'forged'}],['task',rpOnlyTask,{title:'forged'}],['milestone',otherMilestone,{title:'forged'}],['assignment',otherAssignment,{quantity:2}]]]]) {
    for (const [entity,id,patch] of rows) {
      check((await call(tokens[role],'PUT',entity+'/'+id,patch)).status,403,role+' viewing or nested ownership never grants edit '+entity)
      check((await call(tokens[role],'DELETE',entity+'/'+id)).status,403,role+' viewing or nested ownership never grants delete '+entity)
    }
  }
  check((await call(tokens.vp,'POST','process',{...dates,project_id:ownProject,title:prefix,owner_id:foreign})).status,403,'VP cannot create a foreign-owned process in a visible project')
  const delegatedProcess=await create('process',{...dates,project_id:ownProject,title:prefix,owner_id:foreign},tokens.rp)
  check((await call(tokens.rp,'DELETE','process/'+delegatedProcess)).status,204,'RP can create and delete another owner process inside own project')
  check((await call(tokens.vp,'PUT','process/'+ownProcess,{owner_id:foreign})).status,403,'VP cannot transfer process outside own scope')
  check((await call(tokens.vp,'PUT','process/'+ownProcess,{project_id:taskOnlyProject})).status,403,'VP cannot move into inaccessible project')
  check((await call(tokens.rp,'PUT','process/'+foreignProcess,{project_id:foreignProject})).status,403,'RP cannot move process outside own project')
  console.log('PASS built-in roles: ' + checks + ' assertions; CRUD, owner forgery, counts, lists, diagrams, direct access, priority-only, worker zero, assignment invariant')
} finally {
  for (const id of projects) await call(admin,'DELETE','project/'+id)
  for (const id of resources) await call(admin,'DELETE','resource/'+id)
  for (const id of users) await call(admin,'DELETE','user/'+id)
  await http.dispose()
}
