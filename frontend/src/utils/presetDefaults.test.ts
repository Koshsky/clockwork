import { describe, expect, it } from 'vitest'
import { PRESET_DEFAULT_SCOPES, parentScope, togglePresetScope } from './presetDefaults'
import { SCOPE_OPTIONS, scopeOptionLabel } from '@/components/common/UserPermissionsEditor/labels'
import { evalScope } from '@/rbacScope'

describe('process and task permissions follow their parents', () => {
  it.each(['process', 'task'])('removes self from %s options and defaults to up1', (resource) => {
    expect(PRESET_DEFAULT_SCOPES[resource]).toBe('up1')
    expect(SCOPE_OPTIONS[resource].some((option) => option.value === 'self')).toBe(false)
    expect(SCOPE_OPTIONS[resource].some((option) => option.value === (resource === 'process' ? 'project_owner' : 'process_owner'))).toBe(true)
  })
  it('labels the parent instead of row ownership', () => {
    expect(scopeOptionLabel('process', 'up1')).toBe('В проектах сотрудника')
    expect(scopeOptionLabel('task', 'up1')).toBe('В процессах сотрудника')
  })
  it.each(['view', 'create', 'update', 'delete'])('normalizes old cached scopes for %s', () => {
    expect(parentScope('process', 'self')).toBe('up1')
    expect(parentScope('task', 'own')).toBe('up1')
    expect(parentScope('task', 'self up1 sib')).toBe('up1 sib')
    expect(parentScope('project', 'self')).toBe('self')
    expect(parentScope('resource', 'self')).toBe('self')
    expect(parentScope('assignment', 'up1')).toBe('up1')
  })
  it.each(['process', 'task'])('%s access depends on its parent even when row ownership differs', (resource) => {
    const parent = resource === 'process' ? 'projectOwner' : 'processOwner'
    const row = resource === 'process' ? 'processOwner' : 'owner'
    expect(evalScope(parentScope(resource, 'self'), resource, { owner: 8, projectOwner: 8, processOwner: 8, [parent]: 7 }, 7)).toBe(true)
    expect(evalScope(parentScope(resource, 'self'), resource, { owner: 8, projectOwner: 8, processOwner: 8, [row]: 7 }, 7)).toBe(false)
  })
})

describe('empty preset selection denies access', () => {
  it.each(['all', 'self', 'up1', 'up', 'sib', 'sib_project', 'down'])('removes the last %s grant without restoring defaults', (scope) => {
    expect(togglePresetScope(scope, scope)).toBe('none')
  })
  it('keeps denial selected until a grant is explicitly chosen', () => {
    expect(togglePresetScope('none', 'none')).toBe('none')
    expect(togglePresetScope('', 'none')).toBe('none')
    expect(togglePresetScope('none', 'self')).toBe('self')
    expect(togglePresetScope('none', 'all')).toBe('all')
  })
  it('preserves multi-select and makes an explicit denial exclusive', () => {
    expect(togglePresetScope('up1 sib', 'sib')).toBe('up1')
    expect(togglePresetScope('up1 sib', 'none')).toBe('none')
    expect(togglePresetScope('up1 sib', 'all')).toBe('all')
  })
})
