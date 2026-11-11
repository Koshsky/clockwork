import type { TimelineCtx } from '@/composables/timeline-context'

export interface Resource {
  id: number
  code: string
  title: string
  employeesCount: number
}

export interface ResourceHeaderProps {
  t: TimelineCtx
  resources: Resource[]
  usageFn: (resourceId: number, day: Date) => number
  availableFn: (resourceId: number, day: Date) => number | null
}
