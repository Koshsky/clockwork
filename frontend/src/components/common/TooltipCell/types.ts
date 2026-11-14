export interface TooltipCellProps {
  contextKey?: string | number
  /** Tooltip text; may be omitted if content is provided via the #popup slot */
  text?: string
  /** Multiline mode: text wraps across lines (white-space: normal, max-width) */
  multiline?: boolean
  /** When true, the popup never opens (e.g. while dragging a range) */
  disabled?: boolean
}
