/** Timeline cell unit: day, decade (10 days) or week (Monday-start 7 days) */
export type PlanningUnit = 'day' | 'decade' | 'week'

import { DAY_MS, clamp } from '../../utils'
import { fmtDateRange } from '@/i18n/date'

/** Date in the local timezone. "YYYY-MM-DD" strings are parsed as local midnight,
 * not UTC (otherwise getTime() would not match the cells' local midnight). */
export function toDate(v: Date | string | number): Date {
  if (v instanceof Date) return v
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number)
    return new Date(y, m - 1, d)
  }
  return new Date(v)
}

/** Date normalized to the start of the day in the local timezone */
function toDayStart(v: Date | string | number): Date {
  const d = toDate(v)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Date in YYYY-MM-DD format (local timezone) */
export function fmtDate(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Date n days later (YYYY-MM-DD, local timezone) */
export function addDaysISO(date: Date | string | number, days: number): string {
  const d = toDayStart(date)
  return fmtDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days))
}

/** Date n calendar months later (YYYY-MM-DD, local timezone), clamped to the
 *  last day of the target month (May 31 + 6 months = Nov 30, not Dec 1). */
export function addMonthsISO(date: Date | string | number, months: number): string {
  const d = toDayStart(date)
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1)
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate()
  return fmtDate(new Date(target.getFullYear(), target.getMonth(), Math.min(d.getDate(), lastDay)))
}

/**
 * Date range "dd.mm.yyyy — dd.mm.yyyy" (local timezone) for bar tooltips.
 * Locale-aware through src/i18n/date.ts, so it follows the interface language;
 * callers re-render on a language switch (computed/function context).
 */
export function formatDateRange(start: Date | string | number, end: Date | string | number): string {
  return fmtDateRange(toDate(start), toDate(end))
}

/** Last day of the month of date d (a new Date, so the original is not mutated) */
function lastDayOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0)
}

export interface CellSpan {
  startCell: number
  endCell: number
}

export interface CalendarCell {
  index: number
  start: Date
  end: Date
}

// ============================================================================
// Infinite timeline in absolute cell indices.
// origin — the anchor date; cell i — the absolute index (may be negative).
// Day:   i  = origin + i days.
// Decade: cells are aligned to calendar months (1–10 / 11–20 / 21–end), and the
// first decade of the anchor month is partial — it starts at the anchor day
// (cell 0 = [anchor … end of the anchor's calendar decade]). The anchor's own
// calendar decade is split at the anchor: days before it keep a calendar-aligned
// cell with a negative index; every other cell of every month is a full decade.
// ============================================================================

/** Month in absolute count: year*12 + month (for month differences). */
function monthNumber(d: Date): number {
  return d.getFullYear() * 12 + d.getMonth()
}

/** Decade number within the month by date: 0 ([1..10]), 1 ([11..20]), 2 ([21..end]). */
function decadeIndexOfDay(d: Date): number {
  if (d.getDate() <= 10) return 0
  if (d.getDate() <= 20) return 1
  return 2
}

/**
 * Decade layout around the anchor (AGENTS.md: "the first decade of the anchor
 * month is partial — starts at the anchor"). Consequence: the anchor's own
 * calendar decade is split at the anchor day into a before-anchor cell (only
 * when the anchor is strictly inside its decade, not on its first day) and cell
 * 0 — the partial first decade. All other cells stay calendar-aligned, so the
 * anchor month is covered by 3 cells, or 4 when the anchor splits its decade.
 */
interface DecadeLayout {
  /** Anchor month (absolute month number) */
  month: number
  /** Anchor day of month (1..last) */
  anchorDay: number
  /** Calendar decade of the anchor within its month (0/1/2) */
  anchorDec: number
  /** Whether the anchor is strictly inside its calendar decade (a before-anchor cell exists) */
  split: boolean
  /** Cell index of the first cell of the anchor month (0 or negative) */
  base: number
  /** Number of cells covering the anchor month (3, or 4 when split) */
  cells: number
}

function decadeLayout(origin: Date): DecadeLayout {
  const month = monthNumber(origin)
  const anchorDay = origin.getDate()
  const anchorDec = decadeIndexOfDay(origin)
  const split = anchorDay > 10 * anchorDec + 1
  const base = -(anchorDec + (split ? 1 : 0))
  return { month, anchorDay, anchorDec, split, base, cells: 3 + (split ? 1 : 0) }
}

/** Date of an absolute month number and a day of month (JS normalizes overflow). */
function dateAtMonth(month: number, day: number): Date {
  return new Date(Math.floor(month / 12), month % 12, day)
}

/** Calendar decade (0/1/2) of cell i under the anchor layout. */
function decadeOfCell(o: Date, i: number): number {
  const { anchorDec, base, cells } = decadeLayout(o)
  if (i >= base + cells) {
    const rel = i - (base + cells)
    return rel % 3
  }
  if (i < base) {
    const n = base - i
    return 2 - ((n - 1) % 3)
  }
  if (i === 0) return anchorDec
  if (i < 0) {
    const k = i - base
    return k < anchorDec ? k : anchorDec
  }
  return anchorDec + i
}

/**
 * Absolute index of the cell containing the date. Always exists (may be
 * negative). For days — the day difference from origin; for decades — calendar
 * anchoring with the partial first anchor decade (see decadeLayout).
 */
export function cellIndexForDate(
  origin: Date | string | number,
  unit: PlanningUnit,
  date: Date | string | number,
): number {
  const o = toDayStart(origin)
  const d = toDayStart(date)
  if (unit === 'day') return Math.round((d.getTime() - o.getTime()) / DAY_MS)
  if (unit === 'week') return weekIndexForDate(o, d)
  const { month, anchorDay, anchorDec, split, base, cells } = decadeLayout(o)
  const dm = monthNumber(d)
  if (dm === month) {
    const dec = decadeIndexOfDay(d)
    if (dec < anchorDec) return base + dec
    if (dec > anchorDec) return base + dec + (split ? 1 : 0)
    // The anchor's own calendar decade, split at the anchor day.
    return d.getDate() < anchorDay ? base + anchorDec : 0
  }
  if (dm > month) return base + cells + 3 * (dm - month - 1) + decadeIndexOfDay(d)
  return base - 3 * (month - dm) + decadeIndexOfDay(d)
}

/** Start date of cell i (local midnight). */
export function cellStartDate(origin: Date | string | number, unit: PlanningUnit, i: number): Date {
  const o = toDayStart(origin)
  if (unit === 'day') return new Date(o.getFullYear(), o.getMonth(), o.getDate() + i)
  if (unit === 'week') return weekCellStart(o, i)
  const { month, anchorDec, base, cells } = decadeLayout(o)
  if (i >= base + cells) {
    const rel = i - (base + cells)
    return dateAtMonth(month + 1 + Math.floor(rel / 3), 1 + (rel % 3) * 10)
  }
  if (i < base) {
    const n = base - i
    return dateAtMonth(month - 1 - Math.floor((n - 1) / 3), 1 + (2 - ((n - 1) % 3)) * 10)
  }
  // Cells of the anchor month: [base .. base+cells-1]
  if (i === 0) return o
  if (i < 0) {
    const k = i - base
    // k in [0 .. anchorDec): a full calendar decade; k === anchorDec: the
    // before-anchor part of the split decade (starts at the decade start).
    return k < anchorDec ? dateAtMonth(month, 1 + 10 * k) : dateAtMonth(month, 1 + 10 * anchorDec)
  }
  return dateAtMonth(month, 1 + (anchorDec + i) * 10)
}

/** End date of cell i (inclusive, local midnight). */
export function cellEndDate(origin: Date | string | number, unit: PlanningUnit, i: number): Date {
  if (unit === 'day') return cellStartDate(origin, unit, i)
  if (unit === 'week') return weekCellEnd(toDayStart(origin), i)
  const o = toDayStart(origin)
  const { anchorDay, anchorDec, split, base } = decadeLayout(o)
  const start = cellStartDate(origin, unit, i)
  if (i === 0) {
    // Partial first decade: from the anchor day to the end of its calendar decade.
    if (anchorDec === 2) return lastDayOfMonth(start)
    return new Date(start.getFullYear(), start.getMonth(), 10 + 10 * anchorDec)
  }
  if (split && i >= base && i < 0 && i - base === anchorDec) {
    // Before-anchor part of the split decade: decade start … the day before the anchor.
    return new Date(start.getFullYear(), start.getMonth(), anchorDay - 1)
  }
  if (decadeOfCell(o, i) === 2) return lastDayOfMonth(start)
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 9)
}

// ============================================================================
// Weeks stay Monday–Sunday even when the timeline anchor falls mid-week.
// ============================================================================

/** Day-of-week with Monday = 0 … Sunday = 6. */
function dowMonday(d: Date): number {
  return (d.getDay() + 6) % 7
}

/** Monday of the week containing d (local midnight). */
function mondayOfWeek(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - dowMonday(d))
}

/** Civil-day coordinates avoid daylight-saving shifts in calendar geometry. */
function civilDay(d: Date): number {
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS
}

function weekIndexForDate(origin: Date, d: Date): number {
  return (civilDay(mondayOfWeek(d)) - civilDay(mondayOfWeek(origin))) / 7
}

function weekCellStart(origin: Date, i: number): Date {
  const monday = mondayOfWeek(origin)
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 7 * i)
}

function weekCellEnd(origin: Date, i: number): Date {
  const start = weekCellStart(origin, i)
  return new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
}

/** ISO 8601 assigns a week to the year containing its Thursday. */
export function isoWeek(d: Date): { year: number; week: number } {
  const thursday = thursdayOfWeek(d)
  const year = thursday.getFullYear()
  const firstMonday = mondayOfWeek(new Date(year, 0, 4))
  return { year, week: Math.floor((civilDay(thursday) - civilDay(firstMonday)) / 7) + 1 }
}

/** Month boundaries can fall inside a weekly cell rather than on its edge. */
export function weekCoordinate(origin: Date | string | number, date: Date): number {
  return (civilDay(date) - civilDay(mondayOfWeek(toDayStart(origin)))) / 7
}

/** Thursday of the week containing d (the week's ISO-style month anchor). */
function thursdayOfWeek(d: Date): Date {
  const monday = mondayOfWeek(d)
  return new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 3)
}

/** 1-based ordinal of the week within its month: the week containing the month's
 *  1st day is #1; the month is taken from the week's Thursday (ISO week convention),
 *  so a week straddling two months is counted for the month holding its majority. */
export function weekOfMonth(d: Date): number {
  const thursday = thursdayOfWeek(d)
  return Math.floor((thursday.getDate() - 1) / 7) + 1
}

const ROMAN_NUMERALS = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII']

/** Week-of-month ordinal as a Roman numeral (I…VI for a calendar month). */
export function romanNumeral(n: number): string {
  return ROMAN_NUMERALS[n] ?? String(n)
}

/** count consecutive cells starting from fromCell (absolute indices). */
export function windowCells(
  origin: Date | string | number,
  unit: PlanningUnit,
  fromCell: number,
  count: number,
): CalendarCell[] {
  const cells: CalendarCell[] = []
  for (let k = 0; k < count; k++) {
    const i = fromCell + k
    cells.push({ index: i, start: cellStartDate(origin, unit, i), end: cellEndDate(origin, unit, i) })
  }
  return cells
}

/**
 * Span of the interval [start, end] (both bounds inclusive) in absolute cells.
 * endCell — the exclusive bound (index of the cell after the last occupied one).
 * Returns null if the interval is invalid (end < start).
 */
export function cellRangeForSpan(
  origin: Date | string | number,
  unit: PlanningUnit,
  start: Date | string | number,
  end: Date | string | number,
): CellSpan | null {
  const s = toDayStart(start)
  const e = toDayStart(end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null
  if (e.getTime() < s.getTime()) return null
  const startCell = cellIndexForDate(origin, unit, s)
  const endCell = Math.max(cellIndexForDate(origin, unit, e) + 1, startCell + 1)
  return { startCell, endCell }
}

/** Converts a cell span [startCell, endCell) to dates [start, end] (both inclusive). */
export function spanToDates(
  origin: Date | string | number,
  unit: PlanningUnit,
  startCell: number,
  endCell: number,
): { start_date: string; end_date: string } {
  const s = Math.min(startCell, endCell - 1)
  const e = Math.max(endCell, s + 1)
  const last = cellEndDate(origin, unit, e - 1)
  return { start_date: fmtDate(cellStartDate(origin, unit, s)), end_date: fmtDate(last) }
}

/** Parent bounds in absolute cells (for drag clamping). null if not set/invalid. */
export function boundsForSpan(
  origin: Date | string | number,
  unit: PlanningUnit,
  startDate?: Date | string | number | null,
  endDate?: Date | string | number | null,
): CellSpan | null {
  if (startDate == null || endDate == null) return null
  return cellRangeForSpan(origin, unit, startDate, endDate)
}

/**
 * Clamps the date interval [start, end] (both bounds inclusive) into the actual
 * parent bounds [bStart, bEnd]. Result always has end >= start (minimum 1 day).
 * If the bounds are not set — the interval is unchanged.
 */
export function clampSpanDates(
  start: Date | string | number,
  end: Date | string | number,
  bStart?: Date | string | number | null,
  bEnd?: Date | string | number | null,
): { start_date: string; end_date: string } {
  const s = toDayStart(start)
  const e = toDayStart(end)
  if (bStart == null || bEnd == null) {
    return { start_date: fmtDate(s), end_date: fmtDate(e) }
  }
  const bs = toDayStart(bStart)
  const be = toDayStart(bEnd)
  const ns = clamp(s.getTime(), bs.getTime(), be.getTime())
  const ne = clamp(e.getTime(), ns, be.getTime())
  return { start_date: fmtDate(new Date(ns)), end_date: fmtDate(new Date(ne)) }
}

/**
 * Clamps a single date into the actual parent bounds [bStart, bEnd]
 * (both bounds inclusive). If the bounds are not set — the date is unchanged.
 */
export function clampDateToBounds(
  date: Date | string | number,
  bStart?: Date | string | number | null,
  bEnd?: Date | string | number | null,
): string {
  const t = toDayStart(date).getTime()
  if (bStart == null || bEnd == null) {
    return fmtDate(new Date(t))
  }
  const bs = toDayStart(bStart).getTime()
  const be = toDayStart(bEnd).getTime()
  return fmtDate(new Date(clamp(t, bs, be)))
}

/**
 * Fits a NEW item created at `start` with the default length [start, end] into the
 * parent bounds [bStart, bEnd] WITHOUT moving the start: the start is the cell the
 * user clicked, and only containment may move it (a click outside the parent is
 * clamped to the nearest bound). The default length is truncated by the parent's
 * end — the item gets shorter instead of sliding left, which used to make a task
 * created near the end of its process start several cells earlier than the click
 * (a click on the last day produced a task starting a week before it). Never
 * shorter than one day. If the bounds are not set — the interval is unchanged.
 */
export function fitSpanDates(
  start: Date | string | number,
  end: Date | string | number,
  bStart?: Date | string | number | null,
  bEnd?: Date | string | number | null,
): { start_date: string; end_date: string } {
  const s = toDayStart(start)
  const e = toDayStart(end)
  if (bStart == null || bEnd == null) {
    return { start_date: fmtDate(s), end_date: fmtDate(e) }
  }
  const bs = toDayStart(bStart).getTime()
  const be = toDayStart(bEnd).getTime()
  const ns = clamp(s.getTime(), bs, be)
  const ne = clamp(e.getTime(), ns, be)
  return { start_date: fmtDate(new Date(ns)), end_date: fmtDate(new Date(ne)) }
}

/**
 * Date under a fractional absolute cell coordinate (as produced by
 * `cellCoordAtViewportX` in composables/timelineHelpers): the cell's own day for a
 * day cell (its start and end dates coincide), or the day the fraction marks inside
 * a decade cell. The coordinate comes from the CONTENT position, so the fractional
 * scroll of the visible window is already accounted for — the caller must not add
 * a window start of its own.
 */
export function dateAtCellCoord(
  origin: Date | string | number,
  unit: PlanningUnit,
  coord: number,
): Date {
  const i = Math.floor(coord)
  const frac = coord - i
  const start = cellStartDate(origin, unit, i).getTime()
  const end = cellEndDate(origin, unit, i).getTime()
  return new Date(start + Math.round(frac * (end - start)))
}
