export interface ContextMenuItem {
  id: string
  label: string
  /** Active (current) item — highlighted, e.g. the selected timeline scale */
  active?: boolean
}

export interface ContextMenuProps {
  /** Menu visibility */
  open: boolean
  /** Cursor position (clientX / clientY) */
  x: number
  y: number
  items: ContextMenuItem[]
}
