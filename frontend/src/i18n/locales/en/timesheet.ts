import type ru from '../ru/timesheet'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/timesheet.ts. */
export default {
  page: {
    dayTypes: 'Day types',
    title: 'Timesheet',
    allEmployees: 'All employees',
    searchPlaceholder: 'Search by name or position',
    managerAll: 'All managers',
    managerNone: 'No manager',
    resourceAll: 'All resources',
    resourceNone: 'No resource',
    resourceFilterTitle: 'Filter by resource',
    emptyFiltered: 'Nothing found',
    emptyRoster: 'No employee data',
    more: 'Show more ({shown} of {total})',
  },
  cell: {
    weekend: 'Day off',
    workday: 'Working day',
    selection: 'Selected fragment',
  },
  panel: {
    ariaLabel: 'Assign a state',
    close: 'Close',
    clear: 'Reset',
  },
} satisfies Translation<typeof ru>
