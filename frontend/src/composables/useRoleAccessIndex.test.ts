import { beforeEach, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import type { DtoTaskPlanning } from '@/api'

const fixture = vi.hoisted(() => ({ auth: null as unknown, planning: null as unknown, scope: 'up1' }))
vi.mock('../store', async () => {
  const { evalScope } = await import('../rbacScope')
  return {
    useAuthStore: () => fixture.auth,
    usePlanningStore: () => fixture.planning,
    useRbacStore: () => ({
      can: () => true,
      perm: () => fixture.scope,
      canOwn: (resource: Parameters<typeof evalScope>[1], _action: string, owners: Parameters<typeof evalScope>[2], probe: Parameters<typeof evalScope>[4]) =>
        evalScope(fixture.scope, resource, owners, (fixture.auth as { user: { id: number } }).user.id, probe),
    }),
  }
})
import { useRoleAccess } from './useRoleAccess'

function setup(processes: NonNullable<DtoTaskPlanning['processes']>) {
  const auth = reactive({ user: { id: 7, preset: 'worker' } })
  const planning = reactive({ taskPlanning: { processes } })
  fixture.auth = auth
  fixture.planning = planning
  return { auth, planning, access: useRoleAccess() }
}
beforeEach(() => { fixture.scope = 'up1' })

it('bounds ownership reads across 600 bars and repeated scroll renders', () => {
  let reads = 0
  const processes = Array.from({ length: 12 }, (_, p) => ({
    id: p + 1, project_id: Math.floor(p / 6) + 1, owner_id: 8, project_owner_id: 8,
    tasks: Array.from({ length: 50 }, (_, t) => ({ id: p * 50 + t + 1, get owner_id() { reads++; return 8 } })),
  }))
  fixture.scope = 'all'
  const { access } = setup(processes)
  for (let render = 0; render < 4; render++) for (const process of processes) for (const task of process.tasks) {
    expect(access.canManageTask(process.id, task.id)).toBe(true)
    expect(access.canDeleteTask(process.id, task.id)).toBe(true)
  }
  expect(reads).toBeLessThanOrEqual(1200)
})

it('updates peer grants after task, subtask, project and employee changes', () => {
  const { access, auth, planning } = setup([
    { id: 10, project_id: 1, owner_id: 8, tasks: [{ id: 100, owner_id: 8, subtasks: [{ id: 101, owner_id: 7 }] }] },
    { id: 20, project_id: 1, owner_id: 8, tasks: [{ id: 200, owner_id: 8 }] },
    { id: 30, project_id: 2, owner_id: 8, tasks: [] },
  ])
  fixture.scope = 'sib'
  expect(access.canManageTask(10, 100)).toBe(true)
  expect(access.canManageTask(20, 200)).toBe(false)
  fixture.scope = 'sib_project'
  expect(access.canManageTask(20, 200)).toBe(true)
  planning.taskPlanning.processes[0]!.tasks![0]!.subtasks![0]!.owner_id = 8
  expect(access.canManageTask(20, 200)).toBe(false)
  planning.taskPlanning.processes[0]!.tasks!.push({ id: 102, owner_id: 7 })
  expect(access.canManageTask(20, 200)).toBe(true)
  planning.taskPlanning.processes[0]!.project_id = 2
  expect(access.canManageTask(20, 200)).toBe(false)
  expect(access.canCreateTask(30)).toBe(true)
  auth.user.id = 9
  expect(access.canCreateTask(30)).toBe(false)
  planning.taskPlanning = { processes: [{ id: 40, project_id: 3, tasks: [{ id: 400, owner_id: 9 }] }] }
  expect(access.canManageTask(10, 100)).toBe(false)
  expect(access.canManageTask(40, 400)).toBe(true)
})

it('keeps task ownership local to its first matching process and row', () => {
  const { access, planning } = setup([
    { id: 10, owner_id: 8, tasks: [{ id: 100, owner_id: 8, subtasks: [{ id: 100, owner_id: 7 }] }] },
    { id: 10, owner_id: 7, tasks: [{ id: 100, owner_id: 7 }] },
    { id: 20, owner_id: 7, tasks: [{ id: 200, owner_id: 7 }] },
  ])
  fixture.scope = 'up'
  expect(access.canManageTask(10, 100)).toBe(false)
  expect(access.canManageTask(10, 200)).toBe(false)
  expect(access.canManageTask(undefined, 200)).toBe(false)
  expect(access.canManageTask(20, 200)).toBe(true)
  fixture.scope = 'up1'
  expect(access.canAssignTaskResources(20, 200)).toBe(true)
  planning.taskPlanning.processes[2]!.tasks![0]!.owner_id = 8
  expect(access.canAssignTaskResources(20, 200)).toBe(false)
  planning.taskPlanning.processes[2]!.owner_id = 8
  expect(access.canManageTask(20, 200)).toBe(false)
})
