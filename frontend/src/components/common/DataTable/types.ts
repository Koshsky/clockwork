export interface DataTableColumn {
  /** Unique column key (row field used for default rendering and sorting). */
  key: string
  /** Header label (user-facing, Russian). */
  label: string
  /**
   * CSS <track-size> for this column, e.g. '140px' or 'fit-content(420px)'.
   * Defaults to 'fit-content(320px)': content-sized with a hard cap, long
   * values wrap instead of shifting the following columns.
   */
  width?: string
  /** Whether clicking the header toggles sorting (default: true). */
  sortable?: boolean
}

export type SortDir = 1 | -1

export interface DataTableSort {
  key: string
  dir: SortDir
}

export interface DataTableProps<Row = unknown> {
  columns: DataTableColumn[]
  rows: Row[]
  /** Toolbar title shown on the left of the actions slot. */
  title?: string
  /** Empty-state message rendered inside the table (default: 'Нет данных'). */
  emptyText?: string
  /** Clicking a row toggles an expanded detail row below it (default: false). */
  expandable?: boolean
  /** Custom sort value per row+column (default: `row[column.key]`). */
  sortValue?: (row: Row, key: string) => unknown
  /** Initial sort state (e.g. newest-first logs). */
  defaultSort?: { key: string; dir: SortDir } | null
  /** Column header drag-resizing (v-model:column-widths for persistence). */
  resizable?: boolean
  /** Fixed pixel widths per column key (overrides `column.width`). */
  columnWidths?: Record<string, number>
}

/** Cell slot scope: the row plus the column being rendered. */
export interface DataTableCellScope<Row = unknown> {
  row: Row
  column: DataTableColumn
}