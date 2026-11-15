import type { NavCategory } from '../../../composables/useNavigation'

export interface AppNavDrawerProps {
  /** Drawer visibility */
  open: boolean
  /** Permission-filtered nav categories (already RBAC-filtered) */
  categories: NavCategory[]
  /** Currently active route name (for highlighting) */
  activeName?: string
  /** Optional preview override for the configured product name */
  brand?: string
}

export interface AppNavDrawerEmits {
  /** Request to close the drawer (overlay, ×, Esc, item click) */
  close: []
  /** A section header was dragged to a new position among visible sections */
  'reorder-category': [{ from: number; to: number }]
  /** A subsection row was dragged within its own section */
  'reorder-item': [{ catLabel: string; from: number; to: number }]
}