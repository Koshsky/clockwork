import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ContextMenuItem, ContextMenuProps } from '../components/common/ContextMenu'
import { UNIT_OPTIONS } from './usePlanningOrigin'
import type { PlanningUnit } from '../components/planner/calendar'

export interface UnitMenuState {
  x: number
  y: number
}

/**
 * Table header right-click menu: switching the "Day" / "Decade" scale.
 * The active scale is highlighted with a checkmark. Shared across the three planning pages.
 */
export function useUnitMenu(unit: Ref<PlanningUnit>) {
  const menu = ref<UnitMenuState | null>(null)

  const items: ComputedRef<ContextMenuItem[]> = computed(() =>
    UNIT_OPTIONS.map((o) => ({
      id: o.value,
      label: o.label,
      active: unit.value === o.value,
    })),
  )

  function open(x: number, y: number) {
    menu.value = { x, y }
  }

  function close() {
    menu.value = null
  }

  function select(id: string) {
    if (id === 'day' || id === 'week') unit.value = id
    close()
  }

  const bind = computed<ContextMenuProps>(() => ({
    open: !!menu.value,
    x: menu.value?.x ?? 0,
    y: menu.value?.y ?? 0,
    items: items.value,
  }))

  return { open, close, select, bind }
}
