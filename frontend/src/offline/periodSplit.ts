/**
 * Timesheet period splitting with the same semantics as the backend
 * (SetStateRange/DeleteStateRange + insertResidues): when a range [s, e]
 * overlaps intervals, they are NOT removed entirely — [s, e] is subtracted
 * from them, and the "tails" [a, s-1] and [e+1, b] keep their original state.
 * Fully covered intervals are removed. PUT adds a new period [s, e].
 * Pure function without dependencies — used both in the store's optimistic update
 * and in write-through cache deltas (cacheApply).
 */

/** Timesheet period (minimal set of fields needed for splitting) */
export interface DayPeriod {
  id?: number
  state_id?: number
  start_date?: string
  end_date?: string
  state_code?: string
  state_name?: string
  is_available?: boolean
}

/** Fields of the new period for PUT (id + state) */
export interface PutPeriodFields {
  id?: number
  state_id: number
  state_code?: string
  state_name?: string
  is_available?: boolean
}

/** Date YYYY-MM-DD n days from an ISO date (local zone) */
function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00`)
  d.setDate(d.getDate() + days)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${dd}`
}

function overlaps(p: DayPeriod, s: string, e: string): boolean {
  return p.start_date != null && p.end_date != null && !(p.end_date < s || p.start_date > e)
}

/**
 * Applies a PUT/DELETE of range [start, end] to a list of periods.
 *  - op='put': subtracts [s,e] from overlapping intervals (keeping tails),
 *    removes covered ones, then adds the new period putFields.
 *  - op='delete': the same subtraction without insertion; when stateId != null, cuts out
 *    only intervals of the given state (leaves the others untouched).
 * The result is sorted by start_date.
 */
export function applyRangeSplit(
  periods: DayPeriod[],
  op: 'put' | 'delete',
  start: string,
  end: string,
  stateId?: number,
  putFields?: PutPeriodFields,
): DayPeriod[] {
  const out: DayPeriod[] = []
  for (const p of periods) {
    if (p.start_date == null || p.end_date == null || !overlaps(p, start, end)) {
      out.push(p)
      continue
    }
    // DELETE with a state filter: don't touch states other than the given one
    if (op === 'delete' && stateId != null && p.state_id != null && p.state_id !== stateId) {
      out.push(p)
      continue
    }
    if (p.start_date < start) {
      out.push({ ...p, end_date: shiftDate(start, -1) })
    }
    if (p.end_date > end) {
      out.push({ ...p, start_date: shiftDate(end, 1) })
    }
  }
  if (op === 'put' && putFields) {
    out.push({
      id: putFields.id,
      state_id: putFields.state_id,
      start_date: start,
      end_date: end,
      state_code: putFields.state_code,
      state_name: putFields.state_name,
      is_available: putFields.is_available,
    })
  }
  return out.sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
}
