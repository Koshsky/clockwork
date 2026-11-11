import type { DtoResourceCalendar, DtoUserStateResponse } from '@/api'
import { addDaysISO } from '@/components/planner/calendar'

/** Apply only this employee's absence delta to the server's capacity curve. */
export function updatePeriodAvailability(
  calendar: DtoResourceCalendar[],
  resourceId: number,
  before: DtoUserStateResponse[],
  after: DtoUserStateResponse[],
  start: string,
  end: string,
): DtoResourceCalendar[] {
  const absent = (periods: DtoUserStateResponse[], date: string) => periods.some((p) =>
    p.is_available === false && p.start_date != null && p.end_date != null && p.start_date <= date && p.end_date >= date,
  ) ? 1 : 0
  return calendar.map((resource) => {
    if (resource.resource_id !== resourceId) return resource
    return { ...resource, periods: (resource.periods ?? []).flatMap((p) => {
      if (!p.start_date || !p.end_date || p.end_date < start || p.start_date > end) return [p]
      const from = p.start_date > start ? p.start_date : start
      const to = p.end_date < end ? p.end_date : end
      const segments = []
      if (p.start_date < from) segments.push({ ...p, end_date: addDaysISO(from, -1) })
      for (let date = from; date <= to; date = addDaysISO(date, 1)) {
        const delta = absent(before, date) - absent(after, date)
        segments.push({ ...p, start_date: date, end_date: date,
          available: p.available == null ? undefined : p.available + delta,
          unavailable: p.unavailable == null ? undefined : p.unavailable - delta,
        })
      }
      if (p.end_date > to) segments.push({ ...p, start_date: addDaysISO(to, 1) })
      return segments
    }) }
  })
}
