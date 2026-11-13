import { useAppStore, usePlanningStore, useTimesheetStore } from '@/store'

// Snapshot source is carried per request; concurrent foreground reads remain independent.
export function nativeSnapshotReloaders(): Array<{ name: string; run: () => Promise<unknown> }> {
  const app = useAppStore(), planning = usePlanningStore(), timesheet = useTimesheetStore()
  return [
    { name: 'projects', run: () => app.refreshProjects(true, true) },
    { name: 'resources', run: () => app.refreshResources(true, true) },
    { name: 'users', run: () => app.refreshUsers(true) },
    { name: 'staff', run: () => app.refreshMyStaff(true) },
    { name: 'calendar', run: () => app.refreshCalendar(true) },
    { name: 'states', run: () => timesheet.refreshStates(true) },
    { name: 'employees', run: () => timesheet.refreshEmployees(undefined, true, true) },
    { name: 'periods', run: () => timesheet.windowStart ? timesheet.refreshPeriods(timesheet.windowStart, timesheet.windowEnd, true) : Promise.resolve() },
    { name: 'project-plan', run: () => planning.refreshProjectPlanning(true, true) },
    { name: 'process-plan', run: () => planning.refreshProcessPlanning(true, true) },
    { name: 'task-plan', run: () => planning.refreshTaskPlanning(true, true) },
    { name: 'members', run: async () => { for (const row of app.resources) if (row.id != null) await app.refreshResourceMembers(row.id, true) } },
  ]
}
