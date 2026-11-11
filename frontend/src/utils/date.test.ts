/**
 * Pure-logic unit tests for the shared date helpers.
 *
 * The helpers live in src/components/planner/calendar.ts (utils/date.ts only
 * exports DAY_MS): toDate / fmtDate / addDaysISO / addMonthsISO /
 * formatDateRange. They are written as CALENDAR arithmetic in the local
 * timezone (no epoch-ms addition), so month-end clamping, leap years and DST
 * days (23 h / 25 h) all land on the correct calendar date regardless of the
 * host timezone — the tests assert exactly that invariant with known
 * calendar facts.
 */
import { describe, expect, it } from 'vitest'
import {
  addDaysISO,
  addMonthsISO,
  fmtDate,
  toDate,
  formatDateRange,
  cellIndexForDate,
} from '@/components/planner/calendar'

describe('fmtDate / toDate — string round-trips', () => {
  it('round-trips a date string through local midnight', () => {
    const d = toDate('2024-02-29')
    expect(d.getFullYear()).toBe(2024)
    expect(d.getMonth()).toBe(1) // February (0-based)
    expect(d.getDate()).toBe(29)
    expect(fmtDate(d)).toBe('2024-02-29')
  })

  it('normalizes the date part of a Date to YYYY-MM-DD', () => {
    expect(fmtDate(new Date(2025, 0, 5))).toBe('2025-01-05')
    expect(fmtDate(new Date(2025, 11, 31))).toBe('2025-12-31')
  })
})

describe('addDaysISO', () => {
  it('handles month ends', () => {
    expect(addDaysISO('2025-01-31', 1)).toBe('2025-02-01')
    expect(addDaysISO('2025-03-01', -1)).toBe('2025-02-28')
  })

  it('handles leap years (Feb 29)', () => {
    expect(addDaysISO('2024-02-28', 1)).toBe('2024-02-29')
    expect(addDaysISO('2024-02-29', 1)).toBe('2024-03-01')
    expect(addDaysISO('2024-02-29', 366)).toBe('2025-03-01')
    // Non-leap year: no Feb 29.
    expect(addDaysISO('2023-02-28', 1)).toBe('2023-03-01')
  })

  it('round-trips through a negative offset', () => {
    expect(addDaysISO('2024-02-29', -29)).toBe('2024-01-31')
    expect(addDaysISO('2024-02-29', 0)).toBe('2024-02-29')
  })

  it('lands on the next calendar date across a DST transition (23 h / 25 h day)', () => {
    // US spring-forward is 2025-03-09, fall-back 2025-11-02: calendar math
    // must still yield exactly one calendar day, never 23/25 hours later.
    expect(addDaysISO('2025-03-08', 1)).toBe('2025-03-09')
    expect(addDaysISO('2025-11-01', 1)).toBe('2025-11-02')
    expect(addDaysISO('2025-03-09', -1)).toBe('2025-03-08')
  })
})

describe('addMonthsISO', () => {
  it('clamps to the last day of the target month', () => {
    expect(addMonthsISO('2025-01-31', 1)).toBe('2025-02-28')
    expect(addMonthsISO('2025-05-31', 6)).toBe('2025-11-30')
    expect(addMonthsISO('2025-08-31', 1)).toBe('2025-09-30')
  })

  it('handles the leap February (29th is preserved in a leap year only)', () => {
    expect(addMonthsISO('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonthsISO('2024-02-29', 12)).toBe('2025-02-28')
    expect(addMonthsISO('2024-02-29', 1)).toBe('2024-03-29')
  })

  it('handles year boundaries and negative months', () => {
    expect(addMonthsISO('2025-11-30', 2)).toBe('2026-01-30')
    expect(addMonthsISO('2025-01-15', -1)).toBe('2024-12-15')
    expect(addMonthsISO('2025-03-31', -1)).toBe('2025-02-28')
  })
})

describe('formatDateRange / day-unit index', () => {
  it('formats a ru range', () => {
    expect(formatDateRange('2025-01-01', '2025-01-31')).toContain('01.01.2025')
    expect(formatDateRange('2025-01-01', '2025-01-31')).toContain('31.01.2025')
  })

  it('day-unit cell index equals the day difference (DST-day roundtrip)', () => {
    // cellIndexForDate uses rounded ms/day — across a DST transition the day
    // difference still resolves to the calendar-numbered cell.
    expect(cellIndexForDate('2025-03-08', 'day', '2025-03-09')).toBe(1)
    expect(cellIndexForDate('2025-03-09', 'day', '2025-03-08')).toBe(-1)
  })
})