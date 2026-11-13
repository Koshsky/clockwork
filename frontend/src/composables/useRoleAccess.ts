import { computed } from 'vue'
import { useAuthStore, usePlanningStore, useRbacStore } from '../store'
import type { DtoDetailedProcess, DtoDetailedProject, DtoProcess, DtoProject } from '@/api'

type OwnerId = number | null | undefined

/**
 * Capabilities are driven by permissions from the RBAC matrix (/permissions/me),
 * not by a hardcoded role list: the frontend shows an action when the permission
 * exists (plus object ownership where the scope is not "all"). Every helper here
 * mirrors the backend route policy for the same action.
 */
export function useRoleAccess() {
  const auth = useAuthStore()
  const planning = usePlanningStore()
  const rbac = useRbacStore()

  const role = computed(() => auth.user?.preset)
  const userId = computed(() => auth.user?.id)

  // Bar renders must not rescan every task for each ownership and peer check.
  const taskAccess = computed(() => {
    const processes = new Map<OwnerId, { process: DtoDetailedProcess; owners: Map<OwnerId, OwnerId>; sibling: boolean }>()
    const projects = new Set<number>()
    const employee = userId.value
    for (const process of planning.taskPlanning?.processes ?? []) {
      const owners = new Map<OwnerId, OwnerId>()
      let sibling = false
      for (const task of process.tasks ?? []) {
        if (!owners.has(task.id)) owners.set(task.id, task.owner_id)
        if (employee != null && task.owner_id === employee) sibling = true
        for (const subtask of task.subtasks ?? []) {
          if (!owners.has(subtask.id)) owners.set(subtask.id, subtask.owner_id)
          if (employee != null && subtask.owner_id === employee) sibling = true
        }
      }
      if (!processes.has(process.id)) processes.set(process.id, { process, owners, sibling })
      if (sibling && process.project_id != null) projects.add(process.project_id)
    }
    return { processes, projects }
  })

  // === Projects ===

  /** View/list projects: project.view */
  const canViewProjects = computed(() => rbac.can('project', 'view'))

  /** Create project: project.create */
  const canCreateProject = computed(() => rbac.can('project', 'create'))

  /** Reorder project priorities: project.prioritize */
  const canReorderProjects = computed(() => rbac.can('project', 'prioritize'))

  /** Parent project owner of a process (process.update/delete — parent scope) */
  function processProjectOwner(processId: number): OwnerId {
    const project = planning.processPlanning?.projects?.find((p: DtoDetailedProject) =>
      (p.processes ?? []).some((pr: DtoProcess) => pr.id === processId),
    )
    return project?.owner_id ?? null
  }

  /** The process row's own owner (L0) from the planning aggregate. */
  function processOwnerFromPlanning(processId: number): OwnerId {
    const project = planning.processPlanning?.projects?.find((p: DtoDetailedProject) =>
      (p.processes ?? []).some((pr: DtoProcess) => pr.id === processId),
    )
    return project?.processes?.find((pr: DtoProcess) => pr.id === processId)?.owner_id ?? null
  }

  /** Process owner of a task/milestone (task/milestone.update — parent scope) */
  function processOwner(processId: OwnerId): OwnerId {
    if (processId == null) return null
    return taskAccess.value.processes.get(processId)?.process.owner_id ?? null
  }

  function taskProjectOwner(processId: OwnerId): OwnerId {
    return taskAccess.value.processes.get(processId)?.process.project_owner_id ?? null
  }

  function processPeerProbe(projectId: OwnerId) {
    const project = planning.processPlanning?.projects?.find((p) => p.id === projectId)
    return { sibling: (project?.processes ?? []).some((p) => p.owner_id === userId.value && userId.value != null) }
  }

  function taskPeerProbe(processId: OwnerId) {
    const index = taskAccess.value
    const row = index.processes.get(processId)
    return {
      sibling: row?.sibling ?? false,
      projectSibling: row?.process.project_id != null && index.projects.has(row.process.project_id),
    }
  }

  /** Edit project: project.update permission + ownership (own) */
  function canManageProject(projectId: number): boolean {
    const project = planning.projectPlanning?.projects?.find((p: DtoProject) => p.id === projectId)
    return rbac.canOwn('project', 'update', { projectOwner: project?.owner_id ?? null })
  }

  /** Delete project: project.delete permission + ownership (own) */
  function canDeleteProject(projectId: number): boolean {
    const project = planning.projectPlanning?.projects?.find((p: DtoProject) => p.id === projectId)
    return rbac.canOwn('project', 'delete', { projectOwner: project?.owner_id ?? null })
  }

  // === Processes ===

  /** Create process: process.create */
  const canCreateProcess = computed(() => rbac.can('process', 'create'))

  function canCreateProcessInProject(projectId: OwnerId): boolean {
    const project = planning.processPlanning?.projects?.find((p: DtoDetailedProject) => p.id === projectId)
    return rbac.canOwn('process', 'create', { projectOwner: project?.owner_id ?? null, processOwner: project ? userId.value : null }, processPeerProbe(projectId))
  }

  /** Edit process: process.update + ownership (self = process owner, up1 = project owner) */
  function canManageProcess(processId: number): boolean {
    return rbac.canOwn('process', 'update', {
      processOwner: processOwnerFromPlanning(processId),
      projectOwner: processProjectOwner(processId),
    }, processPeerProbe(planning.processPlanning?.projects?.find((p) => (p.processes ?? []).some((pr) => pr.id === processId))?.id))
  }

  /** Delete process: process.delete + ownership (self = process owner, up1 = project owner) */
  function canDeleteProcess(processId: number): boolean {
    return rbac.canOwn('process', 'delete', {
      processOwner: processOwnerFromPlanning(processId),
      projectOwner: processProjectOwner(processId),
    }, processPeerProbe(planning.processPlanning?.projects?.find((p) => (p.processes ?? []).some((pr) => pr.id === processId))?.id))
  }

  /** Reorder processes of a project: process.update + parent */
  function canReorderProcess(projectOwner: OwnerId): boolean {
    return rbac.canOwn('process', 'update', { projectOwner: projectOwner ?? null })
  }

  // === Tasks / milestones ===

  /** Create a task in a process: task.create + parent */
  function canCreateTask(processId: OwnerId): boolean {
    return rbac.canOwn('task', 'create', { processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) }, taskPeerProbe(processId))
  }

  function taskOwner(processId: OwnerId, taskId?: number): OwnerId {
    return taskAccess.value.processes.get(processId)?.owners.get(taskId) ?? null
  }

  /** Edit task: task.update + parent */
  function canManageTask(processId: OwnerId, taskId?: number): boolean {
    return rbac.canOwn('task', 'update', { owner: taskOwner(processId, taskId), processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) }, taskPeerProbe(processId))
  }

  /** Delete task: task.delete + parent */
  function canDeleteTask(processId: OwnerId, taskId?: number): boolean {
    return rbac.canOwn('task', 'delete', { owner: taskOwner(processId, taskId), processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) }, taskPeerProbe(processId))
  }

  function canAssignTaskResources(processId: OwnerId, taskId?: number, action: 'create' | 'delete' = 'create'): boolean {
    const scope = rbac.perm('assignment', action)
    if (scope === 'up1' && (taskOwner(processId, taskId) !== userId.value || processOwner(processId) !== userId.value)) return false
    return rbac.canOwn('assignment', action, { processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) })
  }

  /** Create a milestone in a process: milestone.create + parent */
  function canCreateMilestone(processId: OwnerId): boolean {
    return rbac.canOwn('milestone', 'create', { processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) })
  }

  /** Edit milestone: milestone.update + parent */
  function canManageMilestone(processId: OwnerId): boolean {
    return rbac.canOwn('milestone', 'update', { processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) })
  }

  /** Delete milestone: milestone.delete + parent */
  function canDeleteMilestone(processId: OwnerId): boolean {
    return rbac.canOwn('milestone', 'delete', { processOwner: processOwner(processId), projectOwner: taskProjectOwner(processId) })
  }

  /** View tasks (diagram and comments): task.view; the backend allows adding
   *  comments with the same right (task.comment.create == task.view). */
  const canViewTasks = computed(() => rbac.can('task', 'view'))
  const canAddComment = canViewTasks

  /** Delete comments of other authors: task.update (the author deletes own) */
  const canDeleteOthersComments = computed(() => rbac.can('task', 'update'))

  // === Resources ===

  /** Create a resource: resource.create */
  const canCreateResource = computed(() => rbac.can('resource', 'create'))

  /** Edit resource / manage its members: resource.update + ownership (own) */
  function canManageResource(ownerId: OwnerId): boolean {
    return rbac.canOwn('resource', 'update', { owner: ownerId ?? null })
  }

  /** Delete resource: resource.delete + ownership (own) */
  function canDeleteResource(ownerId: OwnerId): boolean {
    return rbac.canOwn('resource', 'delete', { owner: ownerId ?? null })
  }

  // === States (ownerless dictionary) ===

  const canCreateState = computed(() => rbac.can('state', 'create'))
  const canManageState = computed(() => rbac.can('state', 'update'))
  const canDeleteState = computed(() => rbac.can('state', 'delete'))

  // === Timecard (worker days) ===

  /** Set employee days: worker.update + ownership (own: manager_id) */
  function canAssignEmployeeDays(managerId: OwnerId): boolean {
    return rbac.canOwn('worker', 'update', { owner: managerId ?? null })
  }

  /** Clear employee days: worker.delete + ownership (own: manager_id) */
  function canClearEmployeeDays(managerId: OwnerId): boolean {
    return rbac.canOwn('worker', 'delete', { owner: managerId ?? null })
  }

  return {
    role,
    userId,
    canViewProjects,
    canCreateProject,
    canReorderProjects,
    canManageProject,
    canDeleteProject,
    canCreateProcess,
    canCreateProcessInProject,
    canManageProcess,
    canDeleteProcess,
    canReorderProcess,
    canCreateTask,
    canManageTask,
    canDeleteTask,
    canAssignTaskResources,
    canCreateMilestone,
    canManageMilestone,
    canDeleteMilestone,
    canViewTasks,
    canAddComment,
    canDeleteOthersComments,
    canCreateResource,
    canManageResource,
    canDeleteResource,
    canCreateState,
    canManageState,
    canDeleteState,
    canAssignEmployeeDays,
    canClearEmployeeDays,
  }
}
