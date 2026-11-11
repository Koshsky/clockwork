import { describe, expect, it } from 'vitest'
import { dayTypesAccessible, timesheetPageAccessible } from './timesheetAccess'

describe('day types live inside timesheet with independent administration access', () => {
  for (const action of ['view', 'create', 'update', 'delete']) {
    for (const read of [false, true]) {
      for (const employeeView of [false, true]) {
        it(`${action}, dictionary read ${read}, employee read ${employeeView}`, () => {
          const can = (resource: string, operation: string) => resource === 'worker' ? operation === 'view' && employeeView
            : resource === 'state' && ((operation === 'view' && read) || (operation === action && action !== 'view'))
          expect(dayTypesAccessible(can)).toBe(read && action !== 'view')
          expect(timesheetPageAccessible(can)).toBe(employeeView || (read && action !== 'view'))
        })
      }
    }
  }
  it('unrelated administration rights do not open the timesheet or dictionary editor', () => {
    const can = (resource: string) => ['user_admin', 'rbac_config', 'auto_create'].includes(resource)
    expect(timesheetPageAccessible(can)).toBe(false)
    expect(dayTypesAccessible(can)).toBe(false)
  })
})
