export interface PlannerStatesProps {
  /** Data is loading */
  loading: boolean
  /** Error text (shown as a banner; also centered when there is no data) */
  error: string | null
  /** Whether there is data to render the slot (grid) */
  hasData: boolean
  /** Empty state text; defaults to "No data" */
  emptyText?: string
}
