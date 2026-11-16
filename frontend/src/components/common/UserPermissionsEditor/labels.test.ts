import { ADMIN_CAPABILITIES, permissionBlocks, permissionActionGroups } from './labels'
import { afterEach, describe, expect, it } from 'vitest'
import { setAppLocale, t } from '@/i18n'
import { canonicalScope, evalScope, scopeMoves } from '@/rbacScope'
import { SCOPE_OPTIONS, scopeLabel, scopeOptionDescription, scopeOptionLabel, hasAdditionalScope, simpleScope, viewParentResources } from './labels'

afterEach(() => setAppLocale('ru'))

describe('administrator-facing ownership labels', () => {
  it.each([
    ['project', 'down', 'down', 'relatedProjects'],
    ['process', 'up1', 'up1Projects', 'projectOwner'],
    ['process', 'up', 'projectOrProcessOwner', 'processOwnerChain'],
    ['process', 'sib', 'sharedProject', 'sharedProcessProject'],
    ['process', 'down', 'withEmployeeTasks', 'employeeTasks'],
    ['task', 'up1', 'up1Processes', 'processOwner'],
    ['task', 'up', 'taskProcessOrProjectOwner', 'taskOwnerChain'],
    ['task', 'sib', 'sharedProcess', 'sharedTaskProcess'],
    ['task', 'sib_project', 'sharedProject', 'sharedTaskProject'],
    ['task', 'down', 'withEmployeeSubtasks', 'employeeSubtasks'],
    ['milestone', 'up1', 'ownMilestones', 'processOwner'],
    ['milestone', 'up', 'inEmployeeProjectsOrProcesses', 'processOwnerChain'],
    ['assignment', 'up', 'taskProcessOrProjectOwner', 'assignmentOwnerChain'],
  ])('maps %s %s to the same ownership condition in both languages', (resource, scope, label, help) => {
    const labels = []
    for (const locale of ['ru', 'en'] as const) {
      setAppLocale(locale)
      const labelKey = `adminConfig.perm.zone.${label}`
      const helpKey = `adminConfig.perm.scopeHelp.${help}`
      expect(t(labelKey)).not.toBe(labelKey)
      expect(t(helpKey)).not.toBe(helpKey)
      expect(scopeOptionLabel(resource, scope)).toBe(t(labelKey))
      expect(scopeOptionDescription(resource, scope)).toBe(t(helpKey))
      labels.push(scopeOptionLabel(resource, scope))
    }
    expect(labels[0]).not.toBe(labels[1])
  })

  it('preserves independent project, ancestor and descendant conditions for processes', () => {
    expect(SCOPE_OPTIONS.process.map((option) => option.value)).toEqual(['all', 'project_owner', 'process_owner'])
    expect(scopeMoves('up1 down')).toEqual(['up1', 'down'])
    expect(canonicalScope('up1 down')).toBe('up1 down')
    expect(evalScope('up1', 'process', { projectOwner: 8 }, 7, { descendant: true })).toBe(false)
    expect(evalScope('down', 'process', { projectOwner: 7 }, 7, { descendant: false })).toBe(false)
    expect(evalScope('up1 down', 'process', { projectOwner: 8 }, 7, { descendant: true })).toBe(true)
    expect(evalScope('up1 down', 'process', { projectOwner: 7 }, 7, { descendant: false })).toBe(true)
  })

  it('renders combined and legacy expressions without changing their stored codes', () => {
    setAppLocale('ru')
    expect(scopeLabel('process', 'up1 down')).toBe([scopeOptionLabel('process', 'up1'), scopeOptionLabel('process', 'down')].join(t('authz.scope.join')))
    expect(scopeLabel('process', 'ancestor')).toBe(scopeOptionLabel('process', 'up'))
    setAppLocale('en')
    expect(scopeLabel('process', 'up1 down')).toBe([scopeOptionLabel('process', 'up1'), scopeOptionLabel('process', 'down')].join(t('authz.scope.join')))
    expect(canonicalScope('up1 down')).toBe('up1 down')
  })
})


describe('first iteration scope choices', () => {
  it.each(['project', 'process', 'task', 'milestone', 'assignment'])('keeps %s compact and excludes peer conditions', (resource) => {
    expect(SCOPE_OPTIONS[resource]).toHaveLength(3)
    expect(SCOPE_OPTIONS[resource].some((option) => option.value.startsWith('sib'))).toBe(false)
  })
  it('keeps existing special conditions readable without offering them for new grants', () => {
    expect(hasAdditionalScope('task', 'sib_project')).toBe(true)
    expect(hasAdditionalScope('task', 'project_owner process_owner')).toBe(false)
    expect(simpleScope('process', 'up1')).toBe('project_owner')
    expect(simpleScope('task', 'up1')).toBe('process_owner')
    expect(simpleScope('assignment', 'up1')).toBe('up1')
  })
  it('inherits viewing only through actual containers', () => {
    expect(viewParentResources('project')).toEqual([])
    expect(viewParentResources('process')).toEqual(['project'])
    expect(viewParentResources('task')).toEqual(['project', 'process'])
    expect(viewParentResources('milestone')).toEqual(['project', 'process'])
    expect(viewParentResources('assignment')).toEqual(['project', 'process', 'task'])
    expect(viewParentResources('resource')).toEqual([])
  })
})

describe('administration capabilities', () => {
  const cells = ADMIN_CAPABILITIES.flatMap((capability) => capability.actions.map((action) => ({ resource: capability.resource, action })))
  it('renders seven concrete settings in a single administration card', () => {
    expect(permissionBlocks(cells)).toEqual([
      { resource: 'state', group: 'timesheet', index: 0 },
      { resource: 'administration', group: 'administration', index: 1 },
    ])
    expect(permissionActionGroups('administration', cells)).toHaveLength(7)
  })
  it.each(ADMIN_CAPABILITIES)('$key maps to its independent backend capability', (capability) => {
    const row = permissionActionGroups('administration', cells).find((row) => row.key === capability.key)
    expect(row?.resource).toBe(capability.resource)
    expect(row?.actions).toEqual(capability.actions)
    expect(row?.title).toBeTruthy()
    expect(row?.description).toBeTruthy()
  })
  it('does not offer inoperative page flags or invented operations', () => {
    expect(permissionBlocks([{ resource: 'state_admin', action: 'view' }])).toEqual([])
    expect(permissionActionGroups('administration', [])).toEqual([])
    expect(permissionActionGroups('administration', [{ resource: 'audit', action: 'delete' }])).toEqual([])
  })
  it('preserves unknown backend resources as independent cards', () => {
    expect(permissionBlocks([...cells, { resource: 'new_backend_resource', action: 'view' }])).toContainEqual({
      resource: 'new_backend_resource', group: 'other', index: 1,
    })
  })
  it('keeps dictionary use separate from dictionary changes', () => {
    expect(permissionActionGroups('state', cells)).toEqual([])
    expect(permissionActionGroups('state', [...cells, { resource: 'state', action: 'view' }])).toEqual([
      { key: 'view', actions: ['view'], resource: 'state' },
    ])
  })
  it('retains legacy read-only templates without inventing a write permission', () => {
    expect(permissionActionGroups('administration', [{ resource: 'auto_create', action: 'view' }])[0]?.actions).toEqual(['view'])
  })
})

it('employee management describes calendar periods and excludes unused employee creation', () => {
  const cells = ['view', 'create', 'update', 'delete'].map((action) => ({ resource: 'worker', action }))
  expect(permissionActionGroups('worker', cells)).toEqual([
    { key: 'view', resource: 'worker', actions: ['view'] },
    { key: 'manage', resource: 'worker', actions: ['update', 'delete'], description: 'employeeCalendar' },
  ])
})
