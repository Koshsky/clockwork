import { inject, provide } from 'vue'
import type { InjectionKey, Ref } from 'vue'

/**
 * Active task drag for live resource-load preview:
 * ResourceHeader colors cells as if the task already sits at its new position.
 * Written from TaskBar (on bar dragstart/dragmove/dragend), read in TaskPlanning
 * via the usageForDay → usagePreview wrapper.
 */
export interface DragPreviewState {
  /** Whether a task drag is currently in progress */
  active: boolean
  /** Id of the dragged task (to look up old dates and resources in displayProcesses) */
  taskId: number | null
  /** Proposed new dates (bar span during the drag) */
  startDate: string | null
  endDate: string | null
}

export const DragPreviewKey: InjectionKey<Ref<DragPreviewState>> = Symbol('drag-preview')

/** Get the current drag-preview (null if no provider is mounted) */
export function useDragPreview(): Ref<DragPreviewState> | null {
  return inject(DragPreviewKey, null)
}

/** Register a drag-preview (in TaskPlanning) */
export function provideDragPreview(state: Ref<DragPreviewState>): void {
  provide(DragPreviewKey, state)
}
