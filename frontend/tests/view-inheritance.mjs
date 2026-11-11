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
const resources=[]
try {
  const username='inherit'+Date.now().toString().slice(-8)
  const permissions=['process','task','milestone','assignment'].map(resource=>({resource,action:'view',granted:false,scope:''})).concat([{resource:'project',action:'view',granted:true,scope:'self'}])
  const user=await call(admin,'POST','user',{username,first_name:'View',last_name:'Inheritance',preset:'worker',permissions})
  check(user.status,201,'create view subject');const uid=user.data.user.id;users.push(uid)
  const auth=await call(null,'POST','auth/login',{username,password:user.data.password});check(auth.status,200,'login');const token=auth.data.access_token
  const project=async owner_id=>{const id=await create('project',{...dates,code:prefix+'-'+projects.length,owner_id});projects.push(id);const r=await call(admin,'GET','process?limit=500');for(const p of r.data.items.filter(p=>p.project_id===id))await call(admin,'DELETE','process/'+p.id);return id}
  const ownProject=await project(uid),foreignProject=await project(foreign)
  const process=async(project_id,owner_id)=>create('process',{...dates,project_id,owner_id,title:prefix})
  const inside=await process(ownProject,foreign),outside=await process(foreignProject,uid),hiddenProcess=await process(foreignProject,foreign)
  const task=async(process_id,owner_id,parent_id)=>create('task',{...dates,process_id,owner_id,parent_id,title:prefix})
  const root=await task(inside,foreign),child=await task(inside,foreign,root),other=await task(outside,foreign),hidden=await task(hiddenProcess,foreign)
  const resource=await create('resources',{code:prefix,title:prefix,owner_id:foreign});resources.push(resource)
  const milestone=await create('milestone',{process_id:inside,title:prefix,content:prefix,date:'2026-11-20'})
  const assignment=await create('assignment',{task_id:child,resource_id:resource,quantity:1})
  const all={process:[inside,outside,hiddenProcess],task:[root,child,other,hidden],milestone:[milestone],assignment:[assignment]}
  const expected={process:[inside],task:[root,child],milestone:[milestone],assignment:[assignment]}
  const flat=tasks=>tasks.flatMap(t=>[t.id,...flat(t.subtasks??[])])
  async function assertSet(want,label){
    for(const entity of Object.keys(all)){
      const r=await call(token,'GET',entity+'?limit=500');check(r.status,want[entity]===null?403:200,label+' list '+entity)
      if(want[entity]!==null){check(sorted(r.data.items.map(x=>x.id)),sorted([...want[entity]]),label+' exact list '+entity);check(r.data.total,want[entity].length,label+' exact count '+entity)}
      for(const id of all[entity])check((await call(token,'GET',entity+'/'+id)).status,want[entity]?.includes(id)?200:404,label+' direct '+entity+'/'+id)
    }
    const diagram=await call(token,'GET','planning/tasks');check(diagram.status,200,label+' task diagram');check(sorted(diagram.data.processes.flatMap(p=>flat(p.tasks??[]))),sorted([...want.task]),label+' exact task diagram')
  }
  await assertSet(expected,'project view overrides child denials')
  let perms=await call(token,'GET','permissions/me');for(const entity of Object.keys(all))check(perms.data.some(p=>p.resource===entity&&p.action==='view'&&p.inherited),true,'effective inherited '+entity)
  for(const [entity,id,patch,body]of[
    ['process',inside,{title:'forged'},{...dates,project_id:ownProject,title:prefix,owner_id:uid}],
    ['task',child,{title:'forged'},{...dates,process_id:inside,title:prefix,owner_id:uid}],
    ['milestone',milestone,{title:'forged'},{process_id:inside,date:'2026-11-20',title:prefix,content:prefix}],
    ['assignment',assignment,{quantity:2},{task_id:root,resource_id:resource,quantity:1}],
  ])for(const method of ['PUT','DELETE','POST'])check((await call(token,method,entity+(method==='POST'?'':'/'+id),method==='PUT'?patch:method==='POST'?body:undefined)).status,403,'inherited view never grants '+method+' '+entity)
  const replace=async overrides=>check((await call(admin,'PUT','rbac/users/'+uid+'/permissions',{overrides})).status,200,'replace permissions')
  await replace([{resource:'project',action:'view',granted:false,scope:''},{resource:'process',action:'view',granted:true,scope:'process_owner'},...['task','milestone','assignment'].map(resource=>({resource,action:'view',granted:false,scope:''}))])
  await assertSet({process:[outside],task:[other],milestone:[],assignment:[]},'process view opens contents despite task denial')
  check((await call(token,'GET','project/'+foreignProject)).status,404,'view inheritance never goes upward')
  const subOwned=await task(hiddenProcess,uid,hidden),subForeign=await task(hiddenProcess,foreign,hidden)
  all.task.push(subOwned,subForeign)
  const nestedAssignment=await create('assignment',{task_id:subForeign,resource_id:resource,quantity:1});all.assignment.push(nestedAssignment)
  await replace([{resource:'task',action:'view',granted:true,scope:'down'},{resource:'assignment',action:'view',granted:false,scope:''}])
  await assertSet({process:null,task:[hidden,subOwned,subForeign],milestone:null,assignment:[nestedAssignment]},'task view opens all subtasks and their assignments')
  check((await call(token,'GET','process/'+hiddenProcess)).status,404,'task view never grants parent process view')
  await replace([{resource:'project',action:'view',granted:true,scope:'all'},...['process','task','milestone','assignment'].map(resource=>({resource,action:'view',granted:false,scope:''}))])
  for(const entity of Object.keys(all))for(const id of all[entity])check((await call(token,'GET',entity+'/'+id)).status,200,'all-project view overrides all descendant denials '+entity)
  check((await call(token,'GET','task?owner_id='+foreign+'&limit=500')).status,200,'inherited all allows foreign-owner filter')
  console.log('PASS view inheritance: '+checks+' assertions; parent grants win over child denials, exact lists/counts/diagrams/by-id, recursive task ancestry, independent management')
}finally{
  for(const id of projects)await call(admin,'DELETE','project/'+id)
  for(const id of resources)await call(admin,'DELETE','resource/'+id)
  for(const id of users)await call(admin,'DELETE','user/'+id)
  await http.dispose()
}
