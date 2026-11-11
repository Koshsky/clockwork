/**
 * Node-side matrix tests for the planner calendar math
 * (src/components/planner/calendar.ts) — a pure-logic supplement to the
 * existing TimelineMathDemo story.
 *
 * Covered:
 *  - day units: cell index = day difference from the anchor (incl. negatives);
 *  - decade units: cells aligned to calendar months (1–10 / 11–20 / 21–end);
 *  - the partial anchor decade (commit 9565d06): an anchor mid-month splits its
 *    calendar decade — cell 0 starts at the anchor day, a before-anchor cell
 *    covers [decade start … anchor-1], all other cells stay calendar-aligned;
 *  - anchors exactly on a decade start / on the month's first day (no split);
 *  - month ends and leap Feb 29 (a partial last decade ends at month end);
 *  - tiling & monotonicity: consecutive cells are contiguous (end + 1 day ===
 *    next start), indices strictly follow the calendar order, negative
 *    indices work both for day and decade units;
 *  - spanToDates / cellRangeForSpan round-trips on the split-anchor layout;
 *  - dateAtCellCoord: the date under a fractional cell coordinate (the pointer
 *    conversion feeding the context menu and the bar drag);
 *  - fitSpanDates: span of an item created by a right click inside its parent
 *    (start stays at the clicked cell, the length is truncated by the parent).
 */
import { describe, expect, it } from 'vitest'
import {
  addDaysISO,
  cellEndDate,
  cellIndexForDate,
  cellRangeForSpan,
  cellStartDate,
  dateAtCellCoord,
  fitSpanDates,
  isoWeek,
  weekCoordinate,
  romanNumeral,
  spanToDates,
  weekOfMonth,
  windowCells,
  type PlanningUnit,
} from './calendar'
import { DAY_MS } from '@/utils'

/** Every consecutive pair of cells is contiguous and each cell is non-degenerate. */
function expectContiguous(origin: string, unit: PlanningUnit, from: number, count: number): void {
  const cells = windowCells(origin, unit, from, count)
  expect(cells).toHaveLength(count)
  for (const c of cells) {
    expect(c.index).toBeGreaterThanOrEqual(from)
    expect(c.start.getTime()).toBeLessThanOrEqual(c.end.getTime())
  }
  for (let k = 1; k < cells.length; k++) {
    const prev = cells[k - 1]!
    const cur = cells[k]!
    expect(cur.index).toBe(prev.index + 1)
    // end is inclusive — the next cell starts the day after.
    expect(cur.start.getTime() - prev.end.getTime()).toBe(DAY_MS)
  }
}

describe('day unit', () => {
  it('cell index is the day difference from the anchor (positive and negative)', () => {
    expect(cellIndexForDate('2025-02-28', 'day', '2025-02-28')).toBe(0)
    expect(cellIndexForDate('2025-02-28', 'day', '2025-03-01')).toBe(1)
    expect(cellIndexForDate('2025-02-28', 'day', '2025-02-27')).toBe(-1)
    expect(cellIndexForDate('2025-01-10', 'day', '2025-01-01')).toBe(-9)
    expect(cellIndexForDate('2025-01-10', 'day', '2025-01-19')).toBe(9)
  })

  it('start of cell i is anchor + i days; end equals its own start', () => {
    expect(fmt(cellStartDate('2025-01-10', 'day', -9))).toBe('2025-01-01')
    expect(fmt(cellStartDate('2025-01-10', 'day', 0))).toBe('2025-01-10')
    expect(fmt(cellStartDate('2025-01-10', 'day', 9))).toBe('2025-01-19')
    expect(cellEndDate('2025-01-10', 'day', 3).getTime()).toBe(cellStartDate('2025-01-10', 'day', 3).getTime())
  })

  it('tiles contiguously across a month boundary with negative indices', () => {
    expectContiguous('2025-02-28', 'day', -10, 20)
  })
})

describe('decade unit — anchor on the 1st of the month (no split)', () => {
  const origin = '2025-05-01'

  it('anchor month is covered by three calendar decades 1–10 / 11–20 / 21–end', () => {
    expect(fmt(cellStartDate(origin, 'decade', 0))).toBe('2025-05-01')
    expect(fmt(cellEndDate(origin, 'decade', 0))).toBe('2025-05-10')
    expect(fmt(cellStartDate(origin, 'decade', 1))).toBe('2025-05-11')
    expect(fmt(cellEndDate(origin, 'decade', 1))).toBe('2025-05-20')
    expect(fmt(cellStartDate(origin, 'decade', 2))).toBe('2025-05-21')
    expect(fmt(cellEndDate(origin, 'decade', 2))).toBe('2025-05-31')
  })

  it('cells continue into the next month and before the anchor month', () => {
    expect(fmt(cellStartDate(origin, 'decade', 3))).toBe('2025-06-01')
    expect(fmt(cellEndDate(origin, 'decade', 3))).toBe('2025-06-10')
    expect(fmt(cellStartDate(origin, 'decade', 4))).toBe('2025-06-11')
    expect(fmt(cellStartDate(origin, 'decade', -1))).toBe('2025-04-21')
    expect(fmt(cellEndDate(origin, 'decade', -1))).toBe('2025-04-30')
    expect(fmt(cellStartDate(origin, 'decade', -2))).toBe('2025-04-11')
  })

  it('maps dates to cells across month boundaries', () => {
    expect(cellIndexForDate(origin, 'decade', '2025-05-01')).toBe(0)
    expect(cellIndexForDate(origin, 'decade', '2025-05-10')).toBe(0)
    expect(cellIndexForDate(origin, 'decade', '2025-05-15')).toBe(1)
    expect(cellIndexForDate(origin, 'decade', '2025-05-31')).toBe(2)
    expect(cellIndexForDate(origin, 'decade', '2025-06-05')).toBe(3)
    expect(cellIndexForDate(origin, 'decade', '2025-06-25')).toBe(5)
    expect(cellIndexForDate(origin, 'decade', '2025-04-25')).toBe(-1)
    expect(cellIndexForDate(origin, 'decade', '2025-04-15')).toBe(-2)
    expect(cellIndexForDate(origin, 'decade', '2025-03-31')).toBe(-4)
  })

  it('tiles contiguously across month/year boundaries', () => {
    expectContiguous(origin, 'decade', -5, 12)
  })
})

describe('decade unit — partial anchor decade (9565d06 fix)', () => {
  const origin = '2025-05-15'

  it('cell 0 starts at the anchor day (partial first decade)', () => {
    expect(fmt(cellStartDate(origin, 'decade', 0))).toBe('2025-05-15')
    expect(fmt(cellEndDate(origin, 'decade', 0))).toBe('2025-05-20')
  })

  it('the anchor decade is split: a before-anchor cell covers decade start … anchor-1', () => {
    expect(fmt(cellStartDate(origin, 'decade', -1))).toBe('2025-05-11')
    expect(fmt(cellEndDate(origin, 'decade', -1))).toBe('2025-05-14')
    // The full decade cell before the anchor month stays calendar-aligned.
    expect(fmt(cellStartDate(origin, 'decade', -2))).toBe('2025-05-01')
    expect(fmt(cellEndDate(origin, 'decade', -2))).toBe('2025-05-10')
  })

  it('the rest of the anchor month and the following month stay aligned', () => {
    expect(fmt(cellStartDate(origin, 'decade', 1))).toBe('2025-05-21')
    expect(fmt(cellEndDate(origin, 'decade', 1))).toBe('2025-05-31')
    expect(fmt(cellStartDate(origin, 'decade', 2))).toBe('2025-06-01')
    expect(fmt(cellEndDate(origin, 'decade', 2))).toBe('2025-06-10')
  })

  it('maps dates to the split cells', () => {
    expect(cellIndexForDate(origin, 'decade', '2025-05-10')).toBe(-2)
    expect(cellIndexForDate(origin, 'decade', '2025-05-11')).toBe(-1)
    expect(cellIndexForDate(origin, 'decade', '2025-05-14')).toBe(-1)
    expect(cellIndexForDate(origin, 'decade', '2025-05-15')).toBe(0)
    expect(cellIndexForDate(origin, 'decade', '2025-05-20')).toBe(0)
    expect(cellIndexForDate(origin, 'decade', '2025-05-21')).toBe(1)
    expect(cellIndexForDate(origin, 'decade', '2025-05-31')).toBe(1)
    expect(cellIndexForDate(origin, 'decade', '2025-06-05')).toBe(2)
    expect(cellIndexForDate(origin, 'decade', '2025-04-25')).toBe(-3)
  })

  it('tiles contiguously across the split', () => {
    expectContiguous(origin, 'decade', -3, 8)
  })
})

describe('decade unit — anchor exactly on a decade start (no split)', () => {
  const origin = '2025-05-11'

  it('cell 0 is the full calendar decade 11–20, no before-anchor cell exists', () => {
    expect(fmt(cellStartDate(origin, 'decade', 0))).toBe('2025-05-11')
    expect(fmt(cellEndDate(origin, 'decade', 0))).toBe('2025-05-20')
    expect(fmt(cellStartDate(origin, 'decade', -1))).toBe('2025-05-01')
    expect(fmt(cellEndDate(origin, 'decade', -1))).toBe('2025-05-10')
    expect(cellIndexForDate(origin, 'decade', '2025-05-10')).toBe(-1)
    expect(cellIndexForDate(origin, 'decade', '2025-05-11')).toBe(0)
  })
})

describe('decade unit — leap-month end anchor (Feb 29, split at month end)', () => {
  const origin = '2024-02-29'

  it('the partial anchor decade ends at the month end (Feb 29)', () => {
    expect(fmt(cellStartDate(origin, 'decade', 0))).toBe('2024-02-29')
    expect(fmt(cellEndDate(origin, 'decade', 0))).toBe('2024-02-29')
  })

  it('the split before-anchor cell covers 21–28, the next month starts at 1', () => {
    expect(fmt(cellStartDate(origin, 'decade', -1))).toBe('2024-02-21')
    expect(fmt(cellEndDate(origin, 'decade', -1))).toBe('2024-02-28')
    expect(fmt(cellStartDate(origin, 'decade', 1))).toBe('2024-03-01')
    expect(cellIndexForDate(origin, 'decade', '2024-02-20')).toBe(-2)
    expect(cellIndexForDate(origin, 'decade', '2024-02-21')).toBe(-1)
    expect(cellIndexForDate(origin, 'decade', '2024-02-29')).toBe(0)
  })
})

describe('week unit — Monday anchor (no split)', () => {
  const origin = '2026-07-06' // Monday

  it('cell 0 is the full Monday–Sunday week', () => {
    expect(fmt(cellStartDate(origin, 'week', 0))).toBe('2026-07-06')
    expect(fmt(cellEndDate(origin, 'week', 0))).toBe('2026-07-12')
    expect(fmt(cellStartDate(origin, 'week', 1))).toBe('2026-07-13')
    expect(fmt(cellEndDate(origin, 'week', 1))).toBe('2026-07-19')
    expect(fmt(cellStartDate(origin, 'week', -1))).toBe('2026-06-29')
    expect(fmt(cellEndDate(origin, 'week', -1))).toBe('2026-07-05')
  })

  it('maps dates to weeks', () => {
    expect(cellIndexForDate(origin, 'week', '2026-07-06')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-07-12')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-07-13')).toBe(1)
    expect(cellIndexForDate(origin, 'week', '2026-07-05')).toBe(-1)
    expect(cellIndexForDate(origin, 'week', '2026-06-29')).toBe(-1)
  })

  it('tiles contiguously across month boundaries', () => {
    expectContiguous(origin, 'week', -4, 9)
  })
})

describe('week unit — mid-week anchor (full ISO weeks)', () => {
  const origin = '2026-07-01' // Wednesday

  it('cell 0 covers the full Monday–Sunday week containing the anchor', () => {
    expect(fmt(cellStartDate(origin, 'week', 0))).toBe('2026-06-29')
    expect(fmt(cellEndDate(origin, 'week', 0))).toBe('2026-07-05')
  })

  it('negative cells remain full weeks', () => {
    expect(fmt(cellStartDate(origin, 'week', -1))).toBe('2026-06-22')
    expect(fmt(cellEndDate(origin, 'week', -1))).toBe('2026-06-28')
    expect(fmt(cellStartDate(origin, 'week', -2))).toBe('2026-06-15')
  })

  it('maps dates before and after the anchor into the same week', () => {
    expect(cellIndexForDate(origin, 'week', '2026-06-29')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-06-30')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-07-01')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-07-05')).toBe(0)
    expect(cellIndexForDate(origin, 'week', '2026-07-06')).toBe(1)
    expect(cellIndexForDate(origin, 'week', '2026-06-25')).toBe(-1)
  })

  it('tiles contiguously across the anchor', () => {
    expectContiguous(origin, 'week', -3, 8)
  })
})

describe('ISO week numbering and month boundaries', () => {
  it.each([
    ['2026-07-27', 2026, 31],
    ['2026-08-02', 2026, 31],
    ['2026-12-28', 2026, 53],
    ['2027-01-01', 2026, 53],
    ['2027-01-03', 2026, 53],
    ['2027-01-04', 2027, 1],
    ['2024-12-30', 2025, 1],
  ])('%s belongs to ISO year %i, week %i', (value, year, week) => {
    expect(isoWeek(new Date(`${value}T12:00:00`))).toEqual({ year, week })
  })

  it('positions a month boundary inside an intact week', () => {
    expect(weekCoordinate('2026-07-27', new Date(2026, 7, 1))).toBeCloseTo(5 / 7)
    expect(cellIndexForDate('2026-07-27', 'week', '2026-08-01')).toBe(0)
    expect(fmt(cellEndDate('2026-07-27', 'week', 0))).toBe('2026-08-02')
  })

  it('keeps weekly coordinates aligned across daylight-saving transitions', () => {
    expect(weekCoordinate('2026-03-23', new Date(2026, 3, 1))).toBeCloseTo(9 / 7)
    expect(cellIndexForDate('2026-03-23', 'week', '2026-03-30')).toBe(1)
  })
})

describe('week-of-month ordinal and Roman numerals', () => {
  it('numbers the week containing the 1st as I, incrementing per Monday week', () => {
    expect(weekOfMonth(new Date(2026, 6, 1))).toBe(1) // Wed Jul 1 → I (Thu Jul 2)
    expect(weekOfMonth(new Date(2026, 6, 6))).toBe(2)
    expect(weekOfMonth(new Date(2026, 6, 13))).toBe(3)
    expect(weekOfMonth(new Date(2026, 6, 20))).toBe(4)
    expect(weekOfMonth(new Date(2026, 6, 27))).toBe(5)
  })

  it('resets to I in a new month (week belonging to August)', () => {
    expect(weekOfMonth(new Date(2026, 7, 3))).toBe(1) // Mon Aug 3 → Thu Aug 6 → I
  })

  it('romanNumeral renders I…VI', () => {
    expect(romanNumeral(1)).toBe('I')
    expect(romanNumeral(4)).toBe('IV')
    expect(romanNumeral(5)).toBe('V')
    expect(romanNumeral(6)).toBe('VI')
  })
})

describe('index monotonicity across mixed spans and units', () => {
  it('day indexes are non-decreasing along the calendar', () => {
    const dates = ['2024-12-20', '2025-01-01', '2025-02-28', '2025-03-01', '2025-03-10', '2025-06-15']
    let prev = -Infinity
    for (const d of dates) {
      const i = cellIndexForDate('2025-01-10', 'day', d)
      expect(i).toBeGreaterThanOrEqual(prev)
      prev = i
    }
  })

  it('decade indexes are non-decreasing along the calendar', () => {
    const dates = ['2025-03-31', '2025-04-01', '2025-04-15', '2025-05-10', '2025-05-16', '2025-06-30']
    let prev = -Infinity
    for (const d of dates) {
      const i = cellIndexForDate('2025-05-15', 'decade', d)
      expect(i).toBeGreaterThanOrEqual(prev)
      prev = i
    }
  })
})

describe('spanToDates / cellRangeForSpan round-trips', () => {
  it('day spans round-trip a single day', () => {
    const span = spanToDates('2025-01-10', 'day', 2, 3)
    expect(span).toEqual({ start_date: '2025-01-12', end_date: '2025-01-12' })
    expect(cellRangeForSpan('2025-01-10', 'day', '2025-01-12', '2025-01-12')).toEqual({ startCell: 2, endCell: 3 })
  })

  it('decade spans on a split anchor map back to the anchor-month cells', () => {
    // Cells 0..1 = [anchor … end of its calendar decade].
    const span = spanToDates('2025-05-15', 'decade', 0, 2)
    expect(span).toEqual({ start_date: '2025-05-15', end_date: '2025-05-31' })
    expect(cellRangeForSpan('2025-05-15', 'decade', '2025-05-15', '2025-05-31')).toEqual({ startCell: 0, endCell: 2 })
  })

  it('round-trips a decade built by windowCells', () => {
    const origin = '2025-05-15'
    const cells = windowCells(origin, 'decade', -2, 4)
    for (const c of cells) {
      const back = spanToDates(origin, 'decade', c.index, c.index + 1)
      expect(back.start_date).toBe(fmt(c.start))
      expect(back.end_date).toBe(fmt(c.end))
    }
  })
})

/** YYYY-MM-DD of a local date (mirrors calendar.fmtDate). */
function fmt(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

// Keeps the imported addDaysISO referenced in matrix sanity checks (a DST-safe
// day-step companion of the cell math).
describe('day-step sanity', () => {
  it('steps by calendar days, never by 23/25 h', () => {
    expect(addDaysISO('2025-03-08', 4)).toBe('2025-03-12')
    expect(addDaysISO('2025-03-08', 1)).toBe('2025-03-09')
  })
})
/**
 * dateAtCellCoord turns the fractional cell coordinate produced by
 * cellCoordAtViewportX (composables/timelineHelpers) into a date. For a day cell
 * the result must be that cell's own day for EVERY position inside it — the
 * coordinate already carries the scroll phase, so the date may not shift by a day
 * when the click lands near the cell's left edge.
 */
describe('dateAtCellCoord', () => {
  const origin = '2026-07-01'

  it('day unit: the whole cell maps to its own day, fractions included', () => {
    expect(fmt(dateAtCellCoord(origin, 'day', 0))).toBe('2026-07-01')
    expect(fmt(dateAtCellCoord(origin, 'day', 0.001))).toBe('2026-07-01')
    expect(fmt(dateAtCellCoord(origin, 'day', 0.999))).toBe('2026-07-01')
    expect(fmt(dateAtCellCoord(origin, 'day', 1))).toBe('2026-07-02')
    expect(fmt(dateAtCellCoord(origin, 'day', 15.4))).toBe('2026-07-16')
  })

  it('day unit: negative coordinates (cells before the origin) floor towards -infinity', () => {
    // Cell -1 spans coordinates [-1, 0), cell -2 spans [-2, -1): a coordinate of
    // -1.5 lies inside cell -2, exactly as the positive side behaves.
    expect(fmt(dateAtCellCoord(origin, 'day', -1))).toBe('2026-06-30')
    expect(fmt(dateAtCellCoord(origin, 'day', -0.001))).toBe('2026-06-30')
    expect(fmt(dateAtCellCoord(origin, 'day', -1.5))).toBe('2026-06-29')
    expect(fmt(dateAtCellCoord(origin, 'day', -1.999))).toBe('2026-06-29')
  })

  it('decade unit: the fraction marks a day inside the decade, never the neighbour', () => {
    const cellStart = cellStartDate(origin, 'decade', 1)
    const cellEnd = cellEndDate(origin, 'decade', 1)
    for (const frac of [0, 0.25, 0.5, 0.99]) {
      const d = dateAtCellCoord('2026-07-01', 'decade', 1 + frac)
      const cell = cellIndexForDate('2026-07-01', 'decade', d)
      expect(cell, `coord ${1 + frac} landed in cell ${cell}`).toBe(1)
      expect(d.getTime()).toBeGreaterThanOrEqual(cellStart.getTime())
      expect(d.getTime()).toBeLessThanOrEqual(cellEnd.getTime())
    }
  })

  it('decade unit: the very start of a cell is its first day', () => {
    for (const i of [-2, 0, 1, 4]) {
      expect(dateAtCellCoord('2026-07-01', 'decade', i).getTime())
        .toBe(cellStartDate('2026-07-01', 'decade', i).getTime())
    }
  })
})

/**
 * fitSpanDates decides where a right-click-created item lands. The start must be the
 * clicked cell: fitting the default length into the parent may only truncate the
 * length, never slide the start left. The old shiftSpanDates moved the whole span,
 * so a task created near the end of its process started up to a full default length
 * earlier — e.g. a click on the process's last day produced a 7-day task beginning a
 * week before the click, and a click 6 days before the end began exactly one cell
 * early (the reported "starts at t-1").
 */
describe('fitSpanDates', () => {
  const proc = ['2026-07-15', '2026-08-22'] as const

  it('keeps the clicked start when the default length fits', () => {
    expect(fitSpanDates('2026-08-10', '2026-08-17', ...proc))
      .toEqual({ start_date: '2026-08-10', end_date: '2026-08-17' })
    expect(fitSpanDates('2026-08-15', '2026-08-22', ...proc))
      .toEqual({ start_date: '2026-08-15', end_date: '2026-08-22' })
  })

  it('truncates the length at the parent end instead of moving the start', () => {
    // 08-16 + 7 days sticks out of the process: the old code started at 08-15
    expect(fitSpanDates('2026-08-16', '2026-08-23', ...proc))
      .toEqual({ start_date: '2026-08-16', end_date: '2026-08-22' })
    expect(fitSpanDates('2026-08-22', '2026-08-29', ...proc))
      .toEqual({ start_date: '2026-08-22', end_date: '2026-08-22' })
  })

  it('clamps the start only when the click is outside the parent', () => {
    expect(fitSpanDates('2026-07-10', '2026-07-17', ...proc))
      .toEqual({ start_date: '2026-07-15', end_date: '2026-07-17' })
    // past the parent end: one day on the last day, not a week earlier
    expect(fitSpanDates('2026-08-25', '2026-09-01', ...proc))
      .toEqual({ start_date: '2026-08-22', end_date: '2026-08-22' })
  })

  it('keeps the whole parent when the default length exceeds it', () => {
    const short = ['2026-07-15', '2026-07-19'] as const
    expect(fitSpanDates('2026-07-16', '2026-07-23', ...short))
      .toEqual({ start_date: '2026-07-16', end_date: '2026-07-19' })
    expect(fitSpanDates('2026-07-15', '2026-07-23', ...short))
      .toEqual({ start_date: '2026-07-15', end_date: '2026-07-19' })
  })

  it('returns the span untouched without bounds', () => {
    expect(fitSpanDates('2026-08-16', '2026-08-23'))
      .toEqual({ start_date: '2026-08-16', end_date: '2026-08-23' })
    expect(fitSpanDates('2026-08-16', '2026-08-23', null, null))
      .toEqual({ start_date: '2026-08-16', end_date: '2026-08-23' })
  })

  it('accepts Date objects and mixed inputs', () => {
    const d = new Date(2026, 7, 16) // 2026-08-16, local midnight
    expect(fitSpanDates(d, '2026-08-23', new Date(2026, 6, 15), new Date(2026, 7, 22)))
      .toEqual({ start_date: '2026-08-16', end_date: '2026-08-22' })
  })
})
