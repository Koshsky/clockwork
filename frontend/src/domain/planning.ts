import type { DtoDetailedProcess, DtoDetailedTask } from '@/api'
import type { TaskDatePatch } from './dependencies'

export function findPlanningTask(processes: DtoDetailedProcess[], id: number): DtoDetailedTask | undefined {
  for (const process of processes) {
    const task = (process.tasks ?? []).find((t) => t.id === id)
    if (task) return task
    const subtask = (process.tasks ?? []).flatMap((t) => t.subtasks ?? []).find((t) => t.id === id)
    if (subtask) return subtask
  }
  return undefined
}

export function findTaskProcess(processes: DtoDetailedProcess[], id: number): DtoDetailedProcess | undefined {
  for (const process of processes) {
    if ((process.tasks ?? []).some((task) => task.id === id)) return process
    if ((process.tasks ?? []).some((task) => (task.subtasks ?? []).some((subtask) => subtask.id === id))) return process
  }
  return undefined
}

export function reorderItems<T>(list: T[], from: number, to: number): T[] | null {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length) return null
  const reordered = [...list]
  const moved = reordered.splice(from, 1)[0]
  reordered.splice(to, 0, moved)
  return reordered
}

export function projectPriorityChanges(list: { id?: number; priority?: number }[]): { id: number; priority: number }[] {
  const changes: { id: number; priority: number }[] = []
  list.forEach((project, i) => {
    const priority = i + 1
    if (project.priority !== priority) changes.push({ id: project.id as number, priority })
  })
  return changes
}

// A newer proposal must survive the failure of an earlier in-flight command.
export function taskDateRollback(
  current: { start_date?: string; end_date?: string } | undefined,
  proposed: TaskDatePatch,
  previous: { start_date?: string; end_date?: string },
): { start_date?: string; end_date?: string } | null {
  return current?.start_date === proposed.start_date && current?.end_date === proposed.end_date ? previous : null
}

export function addResourceAssignment<T extends { id?: number }>(resources: T[], assignment: T): T[] {
  return resources.some((r) => r.id === assignment.id) ? resources : [...resources, assignment]
}

export function removeResourceAssignment<T extends { id?: number; assignment_id?: number }>(resources: T[], id: number, by: 'resource' | 'assignment'): T[] {
  return resources.filter((r) => (by === 'resource' ? r.id : r.assignment_id) !== id)
}
