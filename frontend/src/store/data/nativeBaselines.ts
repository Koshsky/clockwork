import { desktopSessionState } from '@/session/desktop'
import { useAppStore, usePlanningStore, useTimesheetStore } from '@/store'
import { acknowledgeDesktopPreconditions, captureDesktopPreconditions, observeDesktopCommand, type DesktopBaselineRequest } from './desktopPreconditions'

function sources() {
  const app = useAppStore(), planning = usePlanningStore(), timesheet = useTimesheetStore()
  return {
    planningProjects: planning.projectPlanning,
    planningProcesses: planning.processPlanning,
    planningTasks: planning.taskPlanning,
    resources: app.resources,
    states: timesheet.states,
    stateBaseline: timesheet.stateBaseline,
    periodBaseline: timesheet.periodBaseline,
  }
}
export function capture(request: DesktopBaselineRequest) { return captureDesktopPreconditions(request, sources()) }
export function acknowledge(request: DesktopBaselineRequest, dto: unknown, baseline: Record<string, string>, previous?: Record<string, string>, contextId?: string) {
  if (contextId && desktopSessionState.value?.contextId !== contextId) return
  acknowledgeDesktopPreconditions(request, dto, baseline, sources(), previous)
  if (request.route?.includes('/user/{id}/days') && previous) useTimesheetStore().confirmPeriodBaseline(Number(request.path?.id), previous, baseline)
}
export function observe(request: DesktopBaselineRequest, operationId: string, tempId?: number, contextId?: string) {
  if (contextId && desktopSessionState.value?.contextId !== contextId) return
  observeDesktopCommand(request, operationId, sources(), tempId)
  const previous = request.preconditions
  if (!previous) return
  const timesheet = useTimesheetStore()
  if (request.route?.includes('/user/{id}/days')) {
    const next = { ...previous, ['user_days:' + request.path?.id]: 'local:' + operationId }
    timesheet.confirmPeriodBaseline(Number(request.path?.id), previous, next)
  }
  if (request.route?.includes('/timesheet/states') && timesheet.stateBaseline?.states === previous.states) timesheet.stateBaseline = { states: 'local:' + operationId }
}
