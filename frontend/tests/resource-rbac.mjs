import { request, expect } from 'playwright/test'
import fs from 'node:fs'
const base = 'http://127.0.0.1:8080/api/v1'
const env = Object.fromEntries(fs.readFileSync(new URL('../../local/dev.env', import.meta.url), 'utf8').split('\n').filter((l)=>/^[A-Z_]+=/.test(l)).map((l)=>{ const i=l.indexOf('=');return[l.slice(0,i),l.slice(i+1).replace(/^['"]|['"]$/g,'')] }))
const http = await request.newContext()
const prefix = 'resource-rbac-'+Date.now()
const users=[],resources=[],subjects=[]
const extraProjects=[]
let projectID=null
async function call(token,method,path,data,extra={}) {
 const r=await http.fetch(base+path,{method,data,headers:{...(token?{Authorization:'Bearer '+token}:{}),...extra}})
 const text=await r.text();const body=text?JSON.parse(text):{};return {status:r.status(),data:body.data,error:body.error}
}
await expect.poll(async()=>{try{return(await http.get(base+'/health')).status()}catch{return 0}},{timeout:20000}).toBe(200)
const login=await call(null,'POST','/auth/login',{username:'admin',password:env.ADMIN_PASSWORD})
expect(login.status).toBe(200)
const admin=login.data.access_token
const adminID=login.data.user.id
async function makeResource(owner,code) {
 const r=await call(admin,'POST','/resources',{code:prefix+'-'+code,title:prefix+'-'+code,owner_id:owner});expect(r.status,JSON.stringify(r.error)).toBe(201);resources.push(r.data.id);return r.data.id
}
try {
 for(const scope of ['self','all','none']) {
  const username='rbac'+Date.now().toString().slice(-8)+scope
  const permissions=['view','create','update','delete'].map(action=>({resource:'resource',action,scope:scope==='none'?'':scope,granted:scope!=='none'})).concat([{resource:'task',action:'view',scope:scope==='self'?'up1':'all',granted:true},{resource:'assignment',action:'create',scope:scope==='self'?'up1':'all',granted:scope!=='none'}])
  for(const resource of ['project','process','milestone','assignment'])permissions.push({resource,action:'view',scope:scope==='self'?(resource==='project'?'self':'up1'):'all',granted:true})
  const u=await call(admin,'POST','/user',{username,first_name:'Test',last_name:'RBAC',preset:'worker',permissions})
  expect(u.status, JSON.stringify(u.error)).toBe(201); const id=u.data.user.id;users.push(id)
  const auth=await call(null,'POST','/auth/login',{username,password:u.data.password});expect(auth.status).toBe(200);const token=auth.data.access_token;subjects.push({id,token,scope})
  const own=await makeResource(id,scope+'-own')
  const foreign=await makeResource(users[0]===id?adminID:users[0],scope+'-foreign')
  const listing=await call(token,'GET','/resources?limit=500')
  if(scope==='none') expect(listing.status).toBe(403)
  else {expect(listing.status).toBe(200);expect(listing.data.items.some(r=>r.id===own)).toBe(true);if(scope==='self')expect(listing.data.items.every(r=>r.owner_id===id)).toBe(true);else expect(listing.data.items.some(r=>r.id===foreign)).toBe(true)}
  for(const [rid,isOwn] of [[own,true],[foreign,false]]) {
   const allowed=scope==='all'||scope==='self'&&isOwn
   const read=await call(token,'GET','/resources/'+rid);expect(allowed?read.status===200:[403,404].includes(read.status)).toBe(true)
   const update=await call(token,'PUT','/resources/'+rid,{title:prefix+'-edited-'+rid});expect(update.status).toBe(allowed?200:403)
  }
  const create=await call(token,'POST','/resources',{code:prefix+'-'+scope+'-created',title:prefix+'-'+scope+'-created'})
  expect(create.status).toBe(scope==='none'?403:201);if(create.data?.id)resources.push(create.data.id)
  const createForeign=await call(token,'POST','/resources',{code:prefix+'-'+scope+'-other',title:prefix+'-'+scope+'-other',owner_id:adminID})
  expect(createForeign.status).toBe(scope==='all'?201:403);if(createForeign.data?.id)resources.push(createForeign.data.id)
  const transfer=await call(token,'PUT','/resources/'+own,{owner_id:adminID})
  expect(transfer.status).toBe(scope==='all'?200:403)
  for(const [rid,isOwn] of [[own,true],[foreign,false]]) {
   const allowed=scope==='all'||scope==='self'&&isOwn
   const del=await call(token,'DELETE','/resources/'+rid);expect([200,204].includes(del.status)).toBe(allowed)
   if(!allowed)expect(del.status).toBe(403)
  }
  expect((await call(token,'GET','/resources',undefined,{'X-View-User-ID':'1'})).status).toBe(403)
  const preview=await call(admin,'GET','/resources?limit=500',undefined,{'X-View-User-ID':String(id)})
  expect(preview.status).toBe(listing.status)
  if(scope==='self')expect(preview.data.items.every(r=>r.owner_id===id)).toBe(true)
  expect((await call(admin,'POST','/resources',{title:'Not allowed',code:prefix+'-preview-write'},{'X-View-User-ID':String(id)})).status).toBe(403)
  console.log('PASS resource CRUD/list/by-id/owner transfer/preview:',scope)
 }
 const a=subjects[0],b=subjects[1]
 const project=await call(admin,'POST','/project',{title:prefix,code:prefix,owner_id:a.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(project.status).toBe(201);projectID=project.data.id
 const makeProcess=async(owner,suffix)=>{const r=await call(admin,'POST','/process',{title:prefix+suffix,project_id:projectID,owner_id:owner,start_date:'2026-11-01',end_date:'2026-12-31'});expect(r.status).toBe(201);return r.data.id}
 const pa=await makeProcess(a.id,'a'),pb=await makeProcess(b.id,'b')
 const makeTask=async(owner,suffix)=>{const r=await call(admin,'POST','/task',{title:prefix+suffix,process_id:pa,owner_id:owner,start_date:'2026-11-09',end_date:'2026-11-22'});expect(r.status).toBe(201);return r.data.id}
 const ta=await makeTask(a.id,'ta'),tb=await makeTask(b.id,'tb')
 const ownProject=await call(admin,'POST','/project',{code:prefix+'-own-project',owner_id:a.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(ownProject.status).toBe(201);extraProjects.push(ownProject.data.id)
 const otherProject=await call(admin,'POST','/project',{code:prefix+'-foreign-project',owner_id:b.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(otherProject.status).toBe(201);extraProjects.push(otherProject.data.id)
 const hiddenOwnProcess=await call(admin,'POST','/process',{title:prefix+'-own-process-in-foreign-project',project_id:otherProject.data.id,owner_id:a.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(hiddenOwnProcess.status).toBe(201)
 const opaqueProcess=await call(admin,'POST','/process',{title:prefix+'-opaque-process',project_id:otherProject.data.id,owner_id:b.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(opaqueProcess.status).toBe(201)
 const hiddenOwnTask=await call(admin,'POST','/task',{title:prefix+'-own-task-in-foreign-process',process_id:opaqueProcess.data.id,owner_id:a.id,start_date:'2026-11-09',end_date:'2026-11-22'});expect(hiddenOwnTask.status).toBe(201)
 const foreignProcessInOwnProject=await call(admin,'POST','/process',{title:prefix+'-foreign-process-in-own-project',project_id:ownProject.data.id,owner_id:b.id,start_date:'2026-11-01',end_date:'2026-12-31'});expect(foreignProcessInOwnProject.status).toBe(201)
 const checkDirectRead=async(path,ownID,foreignIDs)=>{
  const own=await call(a.token,'GET',path+'/'+ownID)
  expect(own.status,path+' own record').toBe(200);expect(own.data.id).toBe(ownID)
  for(const id of foreignIDs){
   const foreign=await call(a.token,'GET',path+'/'+id)
   expect(foreign.status,path+' foreign record '+id).toBe(404)
   expect(foreign.data??{}).toEqual({})
   const all=await call(b.token,'GET',path+'/'+id)
   expect(all.status,path+' all-scope record '+id).toBe(200);expect(all.data.id).toBe(id)
  }
  console.log('PASS direct id '+path+': own 200; foreign 404 without entity data; all 200')
 }
 await checkDirectRead('/project',ownProject.data.id,[otherProject.data.id])
 await checkDirectRead('/process',pa,[hiddenOwnProcess.data.id])
 expect((await call(a.token,'GET','/process/'+pb)).status).toBe(200);expect((await call(a.token,'GET','/process/'+foreignProcessInOwnProject.data.id)).status).toBe(200)
 const makeMilestone=async(processID,suffix)=>{const r=await call(admin,'POST','/milestone',{process_id:processID,title:prefix+suffix,content:'Direct id regression',date:'2026-11-10'});expect(r.status).toBe(201);return r.data.id}
 await checkDirectRead('/milestone',await makeMilestone(pa,'-own-milestone'),[await makeMilestone(opaqueProcess.data.id,'-foreign-milestone')])
 const inheritedMilestone=await makeMilestone(foreignProcessInOwnProject.data.id,'-inherited-milestone');expect((await call(a.token,'GET','/milestone/'+inheritedMilestone)).status).toBe(200)
 expect((await call(a.token,'GET','/process/'+pa)).status).toBe(200)
 const ownTaskByID=await call(a.token,'GET','/task/'+ta)
 expect(ownTaskByID.status).toBe(200);expect(ownTaskByID.data.id).toBe(ta);expect(ownTaskByID.data.owner_id).toBe(a.id)
 expect((await call(a.token,'GET','/task/'+tb)).status).toBe(200)
 const foreignTaskByID=await call(a.token,'GET','/task/'+hiddenOwnTask.data.id)
 expect(foreignTaskByID.status).toBe(404)
 expect(foreignTaskByID.data??{}).not.toHaveProperty('id');expect(foreignTaskByID.data??{}).not.toHaveProperty('title')
 const allTaskByID=await call(b.token,'GET','/task/'+tb)
 expect(allTaskByID.status).toBe(200);expect(allTaskByID.data.id).toBe(tb)
 console.log('PASS task.view=up1 direct id: tasks in own process 200 regardless of task owner; own task in foreign process 404; all 200')
 const ra=await makeResource(a.id,'assigna'),rb=await makeResource(b.id,'assignb')
 const restrictedName='limited'+Date.now().toString().slice(-9)
 const restricted=await call(admin,'POST','/user',{username:restrictedName,first_name:'Limited',last_name:'Assignment',preset:'worker',permissions:[{resource:'task',action:'view',scope:'up1',granted:true},{resource:'assignment',action:'create',scope:'all',granted:true}]})
 expect(restricted.status).toBe(201);users.push(restricted.data.user.id)
 const restrictedLogin=await call(null,'POST','/auth/login',{username:restrictedName,password:restricted.data.password});expect(restrictedLogin.status).toBe(200)
 expect((await call(restrictedLogin.data.access_token,'POST','/assignment',{task_id:ta,resource_id:ra,quantity:1})).status).toBe(403)
 console.log('PASS all assignment scope cannot bypass task visibility')
 for(const token of [admin,a.token,b.token])expect((await call(token,'POST','/assignment',{task_id:ta,resource_id:rb,quantity:1})).status).toBe(403)
 expect((await call(a.token,'POST','/assignment',{task_id:tb,resource_id:ra,quantity:1})).status).toBe(403)
 const previewTasks=await call(admin,'GET','/planning/tasks',undefined,{'X-View-User-ID':String(a.id)})
 const subjectTasks=await call(a.token,'GET','/planning/tasks')
 expect(previewTasks.data).toEqual(subjectTasks.data)
 const ids=previewTasks.data.processes.flatMap(p=>p.tasks??[]).map(t=>t.id)
 expect(ids).toContain(ta);expect(ids).toContain(tb);expect(ids).not.toContain(hiddenOwnTask.data.id)
 console.log('PASS admin subject diagram equals server-scoped subject response')
 const ownAssignment=await call(a.token,'POST','/assignment',{task_id:ta,resource_id:ra,quantity:1});expect(ownAssignment.status,JSON.stringify({error:ownAssignment.error,task:(await call(admin,'GET','/task/'+ta)).data,permissions:(await call(a.token,'GET','/permissions/me')).data})).toBe(201)
 const foreignTaskAssignment=await call(b.token,'POST','/assignment',{task_id:tb,resource_id:ra,quantity:1});expect(foreignTaskAssignment.status).toBe(201)
 const ownTaskInForeignProcess=await call(admin,'POST','/task',{title:prefix+'-own-task-in-foreign-process',process_id:foreignProcessInOwnProject.data.id,owner_id:a.id,start_date:'2026-11-09',end_date:'2026-11-22'});expect(ownTaskInForeignProcess.status).toBe(201)
 const foreignResourceAssignment=await call(admin,'POST','/assignment',{task_id:ownTaskInForeignProcess.data.id,resource_id:rb,quantity:1});expect(foreignResourceAssignment.status).toBe(201)
 const opaqueAssignment=await call(admin,'POST','/assignment',{task_id:hiddenOwnTask.data.id,resource_id:rb,quantity:1});expect(opaqueAssignment.status).toBe(201)
 await checkDirectRead('/assignment',ownAssignment.data.id,[opaqueAssignment.data.id])
 for(const id of [foreignTaskAssignment.data.id,foreignResourceAssignment.data.id])expect((await call(a.token,'GET','/assignment/'+id)).status).toBe(200)
 expect((await call(admin,'PUT','/assignment/'+ownAssignment.data.id,{resource_id:rb})).status).toBe(400)
 expect((await call(admin,'PUT','/resources/'+ra,{owner_id:b.id})).status).toBe(200)
 expect((await call(admin,'GET','/assignment/'+ownAssignment.data.id)).status).toBe(404)
 expect((await call(admin,'PUT','/resources/'+ra,{owner_id:a.id})).status).toBe(200)
 const recreated=await call(admin,'POST','/assignment',{task_id:ta,resource_id:ra,quantity:1});expect(recreated.status).toBe(201)
 expect((await call(admin,'PUT','/process/'+pa,{owner_id:b.id})).status).toBe(200)
 expect((await call(admin,'GET','/assignment/'+recreated.data.id)).status).toBe(404)
 expect((await call(admin,'POST','/assignment',{task_id:ta,resource_id:rb,quantity:1})).status).toBe(201)
 expect((await call(admin,'PUT','/process/'+pb,{owner_id:a.id})).status).toBe(200)
 expect((await call(admin,'GET','/task/'+ta)).data.process_id).toBe(pa)
 console.log('PASS assignment owner invariant: own/all/admin, foreign task, reassignment, owner-change cleanup and task moves')
 const tag='testrbac'+Date.now()
 expect((await call(admin,'POST','/rbac/presets',{tag,name:'Test role'})).status).toBe(201)
 let roleUserID=null, roleResourceID=null
 try {
 const rules=await call(admin,'GET','/rbac/preset-rules')
 const defaults=rules.data.filter(r=>r.preset===tag)
 expect(defaults).toHaveLength(25)
 expect(defaults.every(r=>r.scope===(['process','task','milestone','assignment'].includes(r.resource)?'up1':'self'))).toBe(true)
 console.log('PASS new role defaults: 25 rules in one backend transaction')
 const username='def'+Date.now().toString().slice(-9)
 const member=await call(admin,'POST','/user',{username,first_name:'Default',last_name:'Role',preset:tag});expect(member.status).toBe(201);users.push(member.data.user.id);roleUserID=member.data.user.id
 const auth=await call(null,'POST','/auth/login',{username,password:member.data.password});expect(auth.status).toBe(200)
 const token=auth.data.access_token
 const ownProject=await call(token,'POST','/project',{code:prefix+'default',start_date:'2026-11-01',end_date:'2026-12-31'});expect(ownProject.status,JSON.stringify(ownProject.error)).toBe(201)
 try {
 const ownProcess=await call(token,'POST','/process',{project_id:ownProject.data.id,title:prefix+'defaultprocess',start_date:'2026-11-01',end_date:'2026-12-31'});expect(ownProcess.status,JSON.stringify(ownProcess.error)).toBe(201)
 const ownTask=await call(token,'POST','/task',{process_id:ownProcess.data.id,title:prefix+'defaulttask',start_date:'2026-11-09',end_date:'2026-11-22'});expect(ownTask.status,JSON.stringify(ownTask.error)).toBe(201)
 expect(ownTask.data.owner_id).toBe(member.data.user.id)
 const milestone=await call(token,'POST','/milestone',{process_id:ownProcess.data.id,title:prefix+'milestone',content:'Test milestone',date:'2026-11-10'});expect(milestone.status,JSON.stringify(milestone.error)).toBe(201)
 expect((await call(token,'POST','/milestone',{process_id:pb,title:prefix+'foreignmilestone',content:'Test milestone',date:'2026-11-10'})).status).toBe(403)
 const res=await call(token,'POST','/resources',{code:prefix+'default',title:prefix+'defaultresource'});expect(res.status).toBe(201);resources.push(res.data.id);roleResourceID=res.data.id
 expect(res.data.owner_id).toBe(member.data.user.id)
 const assignment=await call(token,'POST','/assignment',{task_id:ownTask.data.id,resource_id:res.data.id,quantity:1});expect(assignment.status,JSON.stringify(assignment.error)).toBe(201)
 console.log('PASS new role can create own project/process/task/milestone/resource/assignment')
 }finally{await call(admin,'DELETE','/project/'+ownProject.data.id)}

 } finally {if(roleResourceID)await call(admin,'DELETE','/resources/'+roleResourceID);if(roleUserID)await call(admin,'DELETE','/user/'+roleUserID);await call(admin,'DELETE','/rbac/presets/'+tag)}

} finally {
 if(projectID)await call(admin,'DELETE','/project/'+projectID)
 for(const id of extraProjects)await call(admin,'DELETE','/project/'+id)
 for(const id of resources)await call(admin,'DELETE','/resources/'+id)
 for(const id of users)await call(admin,'DELETE','/user/'+id)
 await http.dispose()
}
