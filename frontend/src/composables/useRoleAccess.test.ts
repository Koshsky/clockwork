import type { ScopeProbe } from '../rbacScope'
import { beforeEach, describe, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ scope: 'up1', actions: null as string[] | null }))
vi.mock('../store', async () => {
  const { evalScope } = await import('../rbacScope')
  return {
    useAuthStore: () => ({ user: { id: 7, preset: 'worker' } }),
    usePlanningStore: () => ({
      processPlanning: { projects: [
        { id: 1, owner_id: 7, processes: [{ id: 10, owner_id: 8 }, { id: 11, owner_id: 7 }] },
        { id: 2, owner_id: 8, processes: [{ id: 20, owner_id: 7 }] },
        { id: 3, owner_id: 7, processes: [{ id: 21, owner_id: 8 }] },
      ] },
      taskPlanning: { processes: [
        { id: 30, project_owner_id: 7, project_id: 1, owner_id: 7, tasks: [{ id: 300, owner_id: 8, subtasks: [{ id: 301, owner_id: 7 }] }] },
        { id: 40, project_owner_id: 7, project_id: 1, owner_id: 8, tasks: [{ id: 400, owner_id: 8 }] },
        { id: 50, project_owner_id: 8, project_id: 2, owner_id: 7, tasks: [{ id: 500, owner_id: 8 }] },
      ] },
    }),
    useRbacStore: () => ({ perm: () => state.scope, can: (_resource: string, action: string) => state.actions == null || state.actions.includes(action), canOwn: (_resource: string, _action: string, owners: { owner?: number | null; projectOwner?: number | null; processOwner?: number | null }, probe?: ScopeProbe) => (state.actions == null || state.actions.includes(_action)) && evalScope(state.scope, _resource, owners, 7, probe) }),
  }
})
import { useRoleAccess } from './useRoleAccess'
beforeEach(() => { state.scope = 'up1'; state.actions = null })
describe('planning actions use the selected parent owner', () => {
  it('offers process creation only inside an owned project', () => {
    const access = useRoleAccess()
    expect(access.canCreateProcessInProject(1)).toBe(true)
    expect(access.canCreateProcessInProject(2)).toBe(false)
    expect(access.canCreateProcessInProject(undefined)).toBe(false)
  })
  it('manages processes by project ownership regardless of the process owner', () => {
    const access = useRoleAccess()
    for (const action of [access.canManageProcess, access.canDeleteProcess]) {
      expect(action(10)).toBe(true)
      expect(action(20)).toBe(false)
    }
  })
  it('creates, edits and deletes tasks only inside owned processes', () => {
    const access = useRoleAccess()
    for (const action of [access.canCreateTask, access.canManageTask, access.canDeleteTask]) {
      expect(action(30)).toBe(true)
      expect(action(40)).toBe(false)
    }
  })
  it('preserves all-scope actions in foreign parents', () => {
    state.scope = 'all'
    const access = useRoleAccess()
    expect(access.canCreateProcessInProject(2)).toBe(true)
    expect(access.canManageProcess(20)).toBe(true)
    expect(access.canDeleteTask(40)).toBe(true)
  })
})

describe('shared task and process groups', () => {
  it('uses an owned process rather than project ownership for process peers', () => {
    state.scope = 'sib'
    const access = useRoleAccess()
    expect(access.canCreateProcessInProject(1)).toBe(true)
    expect(access.canManageProcess(10)).toBe(true)
    expect(access.canDeleteProcess(21)).toBe(false)
    expect(access.canCreateProcessInProject(3)).toBe(false)
  })

  it.each(['sib', 'sib_project'])('includes subtask ownership for %s task actions', (scope) => {
    state.scope = scope
    const access = useRoleAccess()
    for (const action of [access.canCreateTask, access.canManageTask, access.canDeleteTask]) {
      expect(action(30)).toBe(true)
      expect(action(40)).toBe(scope === 'sib_project')
      expect(action(50)).toBe(false)
      expect(action(undefined)).toBe(false)
    }
  })
})


describe('exact factory ownership conditions', () => {
  it('RP manages all nested tasks, milestones and assignments only in owned projects', () => {
    state.scope = 'project_owner'
    const access = useRoleAccess()
    for (const action of [access.canCreateTask, access.canManageTask, access.canDeleteTask,
      access.canAssignTaskResources, access.canCreateMilestone, access.canManageMilestone, access.canDeleteMilestone]) {
      expect(action(30)).toBe(true)
      expect(action(40)).toBe(true)
      expect(action(50)).toBe(false)
      expect(action(undefined)).toBe(false)
    }
  })
  it('VP manages foreign-owned tasks inside owned processes only', () => {
    state.scope = 'process_owner'
    const access = useRoleAccess()
    for (const action of [access.canCreateTask, access.canManageTask, access.canDeleteTask,
      access.canAssignTaskResources, access.canCreateMilestone, access.canManageMilestone, access.canDeleteMilestone]) {
      expect(action(30)).toBe(true)
      expect(action(40)).toBe(false)
      expect(action(50)).toBe(true)
    }
    expect(access.canManageProcess(10)).toBe(false)
    expect(access.canManageProcess(20)).toBe(true)
    expect(access.canCreateProcessInProject(2)).toBe(true)
    expect(access.canCreateProcessInProject(99)).toBe(false)
  })
})

describe('object-level write capabilities', () => {
  it('an owned process does not unlock foreign process bars or group reorder', () => {
    state.scope = 'process_owner'
    const access = useRoleAccess()
    expect(access.canManageProcess(11)).toBe(true)
    expect(access.canManageProcess(10)).toBe(false)
    expect(access.canReorderProcess(7)).toBe(false)
    expect(access.canReorderProcess(8)).toBe(false)
  })
  it('legacy ancestor task grants include the task and subtask owner', () => {
    state.scope = 'up'
    const access = useRoleAccess()
    expect(access.canManageTask(30, 301)).toBe(true)
    expect(access.canDeleteTask(40, 400)).toBe(true)
    expect(access.canManageTask(undefined, 301)).toBe(false)
  })
  it('own-task assignment scope cannot assign resources to a foreign-owned task', () => {
    state.scope = 'up1'
    const access = useRoleAccess()
    expect(access.canAssignTaskResources(30, 300)).toBe(false)
    expect(access.canAssignTaskResources(30, 301)).toBe(true)
    expect(access.canAssignTaskResources(40, 400)).toBe(false)
    expect(access.canAssignTaskResources(30)).toBe(false)
  })
  it('missing and explicitly denied permissions disable every write capability', () => {
    for (const scope of ['', 'none']) {
      state.scope = scope
      const access = useRoleAccess()
      expect(access.canManageProcess(11)).toBe(false)
      expect(access.canDeleteProcess(11)).toBe(false)
      expect(access.canManageTask(30, 301)).toBe(false)
      expect(access.canDeleteTask(30, 301)).toBe(false)
      expect(access.canAssignTaskResources(30, 301)).toBe(false)
      expect(access.canManageMilestone(30)).toBe(false)
    }
  })
})


describe('server actions remain independent', () => {
  it.each(['create', 'update', 'delete'])('%s grants do not enable the other actions', (action) => {
    state.scope = 'all'
    state.actions = [action]
    const access = useRoleAccess()
    expect(access.canCreateTask(30)).toBe(action === 'create')
    expect(access.canManageTask(30, 300)).toBe(action === 'update')
    expect(access.canDeleteTask(30, 300)).toBe(action === 'delete')
    expect(access.canCreateProcessInProject(1)).toBe(action === 'create')
    expect(access.canManageProcess(11)).toBe(action === 'update')
    expect(access.canDeleteProcess(11)).toBe(action === 'delete')
    expect(access.canCreateMilestone(30)).toBe(action === 'create')
    expect(access.canManageMilestone(30)).toBe(action === 'update')
    expect(access.canDeleteMilestone(30)).toBe(action === 'delete')
    expect(access.canAssignTaskResources(30, 300)).toBe(action === 'create')
    expect(access.canAssignTaskResources(30, 300, 'delete')).toBe(action === 'delete')
    expect(access.canManageResource(7)).toBe(action === 'update')
    expect(access.canDeleteResource(7)).toBe(action === 'delete')
  })
  it('revocation updates capabilities without recreating the view', () => {
    state.scope = 'all'
    state.actions = ['update', 'delete']
    const access = useRoleAccess()
    expect(access.canManageTask(30, 300)).toBe(true)
    state.actions = []
    expect(access.canManageTask(30, 300)).toBe(false)
    expect(access.canDeleteProcess(11)).toBe(false)
    expect(access.canAssignTaskResources(30, 300, 'delete')).toBe(false)
  })
})
