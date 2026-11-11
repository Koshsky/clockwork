export interface ResourceOption {
  id: number
  title?: string
  code?: string
}

export interface AssignedResource {
  /** Assignment id (from /planning/tasks); absent in legacy data */
  assignment_id?: number
  resource_id: number
  quantity: number
  title?: string
  code?: string
}

export interface AddResourcePayload {
  resource_id: number
  quantity: number
}

export interface ResourceManagerModalProps {
  embedded?: boolean
  open: boolean
  taskId: number
  taskTitle?: string
  resources: ResourceOption[]
  assigned: AssignedResource[]
  canCreate?: boolean
  canDelete?: boolean
  busy?: boolean
  error?: string | null
}
