import type { DependencyType } from '../dependencies'

/** A subtask (operation) row in the task editor todo list. */
export interface SubtaskItem {
  id: number
  title: string
  color?: string
  status?: string
}

/** The task being edited — the left panel values. */
export interface TaskEditorTask {
  id: number
  title: string
  color?: string
  status?: string
  owner_id?: number | null
  responsible_id?: number | null
  process_id: number
}

export interface OwnerOption {
  value: number
  label: string
}

/** Patch emitted by the left panel (status/owner/responsible/title/color).
 *  owner_id is included only when a user is actually selected (null — not
 *  sent); responsible_id=0 clears the responsible person. */
export interface TaskEditorPatch {
  title?: string
  color?: string
  status?: string
  owner_id?: number
  responsible_id?: number
}

export interface NewSubtaskPayload {
  title: string
  color?: string
  status?: string
}

export interface UpdateSubtaskPayload {
  id: number
  patch: { title?: string; color?: string; status?: string }
}

/** One predecessor link of the edited task (from the planning aggregate). */
export interface DependencyItem {
  id: number
  task_id: number
  depends_on_task_id: number
  type: DependencyType
  /** Predecessor title (resolved by the view) for the list row. */
  title: string
}

/** Payload of the "add dependency" form (sent to the view). */
export interface AddDependencyPayload {
  depends_on_task_id: number
  type: DependencyType
}

/** Payload of a dependency type change. */
export interface UpdateDependencyPayload {
  id: number
  type: DependencyType
}

export type TaskEditorSection = 'details' | 'subtasks' | 'dependencies' | 'resources' | 'discussion'

export interface TaskEditorProps {
  workspace?: boolean
  section?: TaskEditorSection
  context?: string
  schedule?: string
  resourceCount?: number
  commentCount?: number
  hasRelatedDrafts?: boolean
  /** Modal visibility */
  open: boolean
  /** The edited task (null — header shows a placeholder) */
  task: TaskEditorTask | null
  /** Subtask list (right panel) */
  subtasks: SubtaskItem[]
  /** Employees for the "owner" select */
  ownerOptions: OwnerOption[]
  /** Predecessor links of the edited task (the "Зависимости" panel) */
  dependencies?: DependencyItem[]
  /** Candidate predecessors for the add form (same-process top-level tasks,
   *  excluding the task itself and current predecessors) */
  dependencyOptions?: OwnerOption[]
  /** Whether the user can change the task (status/owner/title/color) */
  canManage?: boolean
  /** Whether the user can add subtasks (same as canManage) */
  canCreateSubtask?: boolean
  canUpdateSubtask?: (id: number) => boolean
  canDeleteSubtask?: (id: number) => boolean
  /** Whether the user can manage dependencies (same as canManage) */
  canManageDependencies?: boolean
  busy?: boolean
  error?: string | null
  /** Subtask form is disabled — shown instead of a spinner */
  disabledReason?: string | null
}

export interface TaskEditorEmits {
  /** Left panel: save the edited task fields */
  save: [patch: TaskEditorPatch, acknowledge?: (saved: boolean) => void]
  'update:section': [section: TaskEditorSection]
  /** Right panel: add a subtask */
  addSubtask: [payload: NewSubtaskPayload]
  /** Right panel: update a subtask field */
  updateSubtask: [payload: UpdateSubtaskPayload]
  /** Right panel: delete a subtask */
  deleteSubtask: [id: number]
  /** Dependencies panel: add a predecessor link */
  addDependency: [payload: AddDependencyPayload]
  /** Dependencies panel: change a link type */
  updateDependency: [payload: UpdateDependencyPayload]
  /** Dependencies panel: delete a link */
  deleteDependency: [id: number]
  close: []
}