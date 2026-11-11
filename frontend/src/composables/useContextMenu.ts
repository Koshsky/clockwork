import { computed } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { ContextMenuItem, ContextMenuProps } from '../components/common/ContextMenu'

/** Base menu state: coordinates; the page extends it with its own id fields */
export interface ContextMenuState {
  x: number
  y: number
}

/**
 * Right-click menu machine: state + ready-made props for <ContextMenu>.
 * menu — external ref (the page can build items from its fields), items —
 * reactive list of entries, onSelect — selection handler (reads menu.value
 * and dispatches by id; menu closing happens automatically).
 */
export function useContextMenu<T extends ContextMenuState>(
  menu: Ref<T | null>,
  items: ComputedRef<ContextMenuItem[]>,
  onSelect: (id: string) => void,
) {
  function open(state: T) {
    menu.value = state
  }

  function close() {
    menu.value = null
  }

  function select(id: string) {
    onSelect(id)
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
