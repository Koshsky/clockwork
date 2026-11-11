/**
 * Timeline view state kept across mounts (tab switches).
 *
 * The horizontal position is stored as a DATE, never as a scroll offset in px: a
 * px offset only means something together with the range grown to the left
 * (`leftPad`, the cells materialized before the origin), and that range is
 * re-seeded on every mount. Restoring `scrollLeft` alone therefore landed at a
 * later date on every switch — after panning ten days into the past, coming back
 * from another tab showed future dates only.
 */
export interface TimelineViewState {
  /** Date of the first visible cell (YYYY-MM-DD); null — unknown */
  firstDate: string | null
  /**
   * Position inside that cell (0..1). Kept so that save → restore is EXACT: the
   * cell index alone snaps the view to the cell start (up to ten days for decade
   * cells), and an exactly cell-aligned anchor is fragile — multiplying by the zoom
   * and dividing it back can land a hair below the boundary, so the next save would
   * step one more cell to the left on every switch.
   */
  firstFraction: number
  /** Cell width in px (--cell-width, "column compression") */
  cellPx: number
  /** Table scale (CSS zoom of .tg-content) */
  scale: number
}

/**
 * Ids that share ONE view position: projects, processes and tasks are the same
 * timeline at different levels, so moving through them must not re-anchor the
 * view. The timesheet keeps its own state (a different roster and page).
 */
const SHARED_TIMELINE_IDS = new Set(['project', 'process', 'task'])

/** State key of a table: the three planner diagrams share one, the rest are separate */
function viewKey(id: string): string {
  return SHARED_TIMELINE_IDS.has(id) ? 'planner' : id
}

/** View state per key (in memory: survives unmounts, reset by a page reload) */
const views = new Map<string, TimelineViewState>()
/** Vertical scroll stays per table — different tables have different rows */
const scrollTops = new Map<string, number>()

/** Persist the timeline view (first visible date, scale, cell width) between mounts */
export function useTableState() {
  function get(id: string | undefined): TimelineViewState | undefined {
    return id ? views.get(viewKey(id)) : undefined
  }

  function save(id: string | undefined, state: TimelineViewState): void {
    if (id) views.set(viewKey(id), state)
  }

  function getScrollTop(id: string | undefined): number {
    return id ? scrollTops.get(id) ?? 0 : 0
  }

  function saveScrollTop(id: string | undefined, px: number): void {
    if (id) scrollTops.set(id, px)
  }

  return { get, save, getScrollTop, saveScrollTop }
}
