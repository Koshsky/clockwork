import { usePlanningStore } from '../store'
import type { DtoDetailedProcess, DtoDetailedProject, DtoDetailedTask, DtoMilestone, DtoProcess, DtoProject } from '@/api'

/** Find tasks/milestones/processes/projects in the /planning/* tree (instead of scattered flatMap().find()) */
export function useFindPlanningItem() {
  const planning = usePlanningStore()

  function findTask(id: number) {
    for (const p of planning.taskPlanning?.processes ?? []) {
      const t = (p.tasks ?? []).find((x: DtoDetailedTask) => x.id === id)
      if (t) return t
      const s = (p.tasks ?? [])
        .flatMap((x: DtoDetailedTask) => x.subtasks ?? [])
        .find((x: DtoDetailedTask) => x.id === id)
      if (s) return s
    }
    return undefined
  }

  function findMilestone(id: number) {
    return planning.taskPlanning?.processes
      ?.flatMap((p: DtoDetailedProcess) => p.milestones ?? [])
      .find((x: DtoMilestone) => x.id === id)
  }

  function findProcess(id: number) {
    return planning.processPlanning?.projects
      ?.flatMap((p: DtoDetailedProject) => p.processes ?? [])
      .find((x: DtoProcess) => x.id === id)
  }

  function findProject(id: number) {
    return planning.projectPlanning?.projects?.find((x: DtoProject) => x.id === id)
  }

  return { findTask, findMilestone, findProcess, findProject }
}
