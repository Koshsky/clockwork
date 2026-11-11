import { describe, expect, it } from 'vitest'
import { PAGE_PERMISSIONS, pageAllowed } from './pageAccess'

describe('page access follows server action grants', () => {
  it.each(Object.entries(PAGE_PERMISSIONS))('%s denies missing rights and accepts only its required action', (page, [resource, action]) => {
    expect(pageAllowed(page, () => false)).toBe(false)
    expect(pageAllowed(page, (r, a) => r === resource && a === action)).toBe(true)
    expect(pageAllowed(page, (r) => r === 'unrelated')).toBe(false)
  })
  it.each(['create', 'update', 'delete'])('resource %s alone opens the resource page', (action) => {
    expect(pageAllowed('resources', (r, a) => r === 'resource' && a === action)).toBe(true)
  })
  it.each(['user-new', 'user-edit', 'user-access'])('%s is not unlocked by user listing', (page) => {
    expect(pageAllowed(page, (r, a) => r === 'user_admin' && a === 'view')).toBe(false)
  })
  it.each(['profile', 'system-settings', 'system-queue'])('%s remains available without business permissions', (page) => {
    expect(pageAllowed(page, () => false)).toBe(true)
  })
})

describe('administration isolation', () => {
  const rights = ['user_admin/view', 'user_admin/update', 'rbac_config/update', 'auto_create/view', 'auto_create/update', 'state/view', 'state/update', 'org_structure/view', 'audit/view', 'user_catalog/view', 'worker/view']
  const pages: Record<string, string[]> = {
    users: ['user_admin/view'], permissions: ['rbac_config/update'], 'user-access': ['rbac_config/update'],
    'auto-create': ['auto_create/view', 'auto_create/update'],
    structure: ['org_structure/view'], audit: ['audit/view'], employees: ['worker/view'],
  }
  it.each(Object.entries(pages))('%s accepts its own permissions and rejects unrelated settings', (page, allowed) => {
    for (const key of rights) {
      expect(pageAllowed(page, (resource, action) => `${resource}/${action}` === key), `${page}/${key}`).toBe(allowed.includes(key))
    }
  })
  it('does not revive removed administration view or status page permissions', () => {
    for (const page of ['permissions', 'auto-create']) {
      expect(pageAllowed(page, (r, a) => (r === 'rbac_config' || r === 'state_admin') && a === 'view')).toBe(false)
    }
  })
})
