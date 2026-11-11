/**
 * Vector renderer of the Gantt diagram to PDF (printer output).
 *
 * A pure function with no dependencies on Vue/DOM/stores: input — the group model
 * (processes → tasks/milestones) and print settings, output — PDF bytes.
 * Dates and cells are computed via calendar.ts, layout constants from layout.ts,
 * so print matches the on-screen diagram.
 *
 * Pagination: A4 landscape, the timeline is cut by columns (each page — its own
 * date slice), rows — across pages vertically; the label column and the calendar
 * header repeat on every page. Cell width is given in screen px
 * (multiplied by 0.75 → pt).
 */
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { cellIndexForDate, cellStartDate, cellEndDate, fmtDate, toDate, type PlanningUnit } from '../calendar'
import { t, currentLocale, type AppLocale } from '@/i18n'
import { fmtDateRange, fmtMonthLong, weekdayShort } from '@/i18n/date'
import { DAY_MS } from '../../../utils'
import {
  CELL_PX_NUM_DAY,
  CELL_PX_NUM_DECADE,
  CELL_PX_WD_DAY,
  LABEL_WIDTH,
  headerHeight,
} from '../layout'
import robotoBoldUrl from '@/assets/fonts/Roboto-Bold.ttf?url'
import robotoRegularUrl from '@/assets/fonts/Roboto-Regular.ttf?url'

/** Screen px → pt (print at 1:1 scale with the screen layout) */
const PT = 0.75

/** Min cell width in pt: below it columns are indistinguishable, so a wider
 *  print range is truncated to the column capacity of one page width instead */
const MIN_CELL_W = 0.5

/** A4 landscape (pt) */
const PAGE_W = 841.89
const PAGE_H = 595.28

/** Equal margin on all sides of the page (pt) */
const MARGIN = 16
const FOOTER_H = 18

/** Label column width in pt (180px screen) */
const labelW = LABEL_WIDTH * PT
/** Milestone strip in a group in pt (20px) */
const msStripH = 20 * PT
/** Min height of the group merged label in pt (64px, as on screen) */
const minGroupH = 64 * PT
/** Header row heights (18px on screen, top offset 2) */
const monthRowH = 20 * PT
const numRowH = 18 * PT
const wdRowH = 18 * PT
/** Resource row height in the usage block in pt (18px) */
const rsRowH = 18 * PT

type Color = ReturnType<typeof rgb>

/** Drawing palette: color (as on screen) or black-and-white outline */
interface Palette {
  headerBg: Color
  headerLine: Color
  groupLine: Color
  gridLine: Color
  labelLine: Color
  labelBg: Color
  textMain: Color
  textMid: Color
  textDim: Color
  textFaint: Color
  /** Month name in the header (#444) */
  textHeader: Color
  /** Numbers in the header (#666) */
  textHeaderNum: Color
  /** Group title in the merged label (#555) */
  groupTitle: Color
  /** Process code in the group merged label */
  codeText: Color
  bar: Color
  barOpacity: number
  barText: Color
  barBorder?: Color
  barBorderWidth: number
  badgeText: Color
  badgeBorder?: Color
  badgeBorderWidth: number
  codeBadgeBg: Color
  codeBadgeOpacity: number
  resBadgeBg: Color
  resBadgeOpacity: number
  ms: Color
  /** Milestone ray color (black in mono so the ray is visible over the bars) */
  msRay: Color
  msOpacity: number
  msBorder?: Color
  msBorderWidth: number
  today: Color
  todayOpacity: number
  groupTint: Color
  groupTintOpacity: number
  usageNormal: Color
  usageWarn: Color
  usageCritical: Color
  usageWeekend: Color
  usageUnknown: Color
  /** Text inside colored usage cells */
  usageText: Color
}

const BLACK = rgb(0, 0, 0)
const WHITE = rgb(1, 1, 1)

/** Color style — the planner's current coloring */
const COLOR_PALETTE: Palette = {
  headerBg: rgb(248 / 255, 249 / 255, 250 / 255), // #f8f9fa
  headerLine: rgb(230 / 255, 230 / 255, 230 / 255), // #e6e6e6
  groupLine: rgb(224 / 255, 224 / 255, 224 / 255), // #e0e0e0
  gridLine: rgb(228 / 255, 230 / 255, 232 / 255), // #e4e6e8
  labelLine: rgb(240 / 255, 240 / 255, 240 / 255), // #f0f0f0
  labelBg: WHITE,
  textMain: rgb(0.2, 0.2, 0.2),
  textMid: rgb(0.333, 0.333, 0.333),
  textDim: rgb(0.533, 0.533, 0.533),
  textFaint: rgb(0.6, 0.6, 0.6),
  textHeader: rgb(68 / 255, 68 / 255, 68 / 255), // #444
  textHeaderNum: rgb(102 / 255, 102 / 255, 102 / 255), // #666
  groupTitle: rgb(85 / 255, 85 / 255, 85 / 255), // #555
  codeText: rgb(26 / 255, 115 / 255, 232 / 255), // #1a73e8
  bar: rgb(52 / 255, 168 / 255, 83 / 255), // #34a853
  barOpacity: 0.75,
  barText: WHITE,
  barBorder: undefined,
  barBorderWidth: 0,
  badgeText: WHITE,
  badgeBorder: undefined,
  badgeBorderWidth: 0,
  codeBadgeBg: BLACK,
  codeBadgeOpacity: 0.22,
  resBadgeBg: rgb(217 / 255, 48 / 255, 37 / 255), // #d93025
  resBadgeOpacity: 1,
  ms: rgb(251 / 255, 188 / 255, 4 / 255), // #fbbc04
  msRay: rgb(251 / 255, 188 / 255, 4 / 255), // #fbbc04
  msOpacity: 0.55,
  msBorder: undefined,
  msBorderWidth: 0,
  today: rgb(229 / 255, 57 / 255, 53 / 255), // #e53935
  todayOpacity: 0.9,
  groupTint: BLACK,
  groupTintOpacity: 0.04,
  usageNormal: rgb(170 / 255, 207 / 255, 207 / 255), // #aacfcf
  usageWarn: rgb(230 / 255, 212 / 255, 136 / 255), // #e6d488
  usageCritical: rgb(224 / 255, 154 / 255, 154 / 255), // #e09a9a
  usageWeekend: rgb(240 / 255, 240 / 255, 240 / 255), // #f0f0f0
  usageUnknown: WHITE,
  usageText: rgb(0.2, 0.2, 0.2), // #333
}

/** Black-and-white outline style: all text black, blocks light gray with outlines */
const MONO_PALETTE: Palette = {
  headerBg: WHITE,
  headerLine: rgb(200 / 255, 200 / 255, 200 / 255), // #c8c8c8
  groupLine: rgb(144 / 255, 144 / 255, 144 / 255), // #909090
  gridLine: rgb(224 / 255, 224 / 255, 224 / 255), // #e0e0e0
  labelLine: rgb(216 / 255, 216 / 255, 216 / 255), // #d8d8d8
  labelBg: WHITE,
  textMain: BLACK,
  textMid: BLACK,
  textDim: BLACK,
  textFaint: BLACK,
  textHeader: BLACK,
  textHeaderNum: BLACK,
  groupTitle: BLACK,
  codeText: BLACK,
  bar: rgb(236 / 255, 236 / 255, 236 / 255), // #ececec
  barOpacity: 1,
  barText: BLACK,
  barBorder: BLACK,
  barBorderWidth: 0.6,
  badgeText: BLACK,
  badgeBorder: BLACK,
  badgeBorderWidth: 0.6,
  codeBadgeBg: rgb(224 / 255, 224 / 255, 224 / 255), // #e0e0e0
  codeBadgeOpacity: 1,
  resBadgeBg: WHITE,
  resBadgeOpacity: 1,
  ms: rgb(240 / 255, 240 / 255, 240 / 255), // #f0f0f0
  msRay: BLACK,
  msOpacity: 0.5,
  msBorder: BLACK,
  msBorderWidth: 0.6,
  today: BLACK,
  todayOpacity: 1,
  groupTint: BLACK,
  groupTintOpacity: 0.02,
  usageNormal: rgb(242 / 255, 242 / 255, 242 / 255), // #f2f2f2
  usageWarn: rgb(214 / 255, 214 / 255, 214 / 255), // #d6d6d6
  usageCritical: rgb(184 / 255, 184 / 255, 184 / 255), // #b8b8b8
  usageWeekend: rgb(250 / 255, 250 / 255, 250 / 255), // #fafafa
  usageUnknown: WHITE,
  usageText: BLACK,
}

function buildPalette(style?: 'color' | 'mono'): Palette {
  return style === 'mono' ? MONO_PALETTE : COLOR_PALETTE
}

export interface PdfGanttResource {
  /** Resource id (resource_id from the DTO) — for matching in the usage block */
  id?: number
  code?: string
  title?: string
  quantity?: number
}

export interface PdfGanttRow {
  id?: number | string
  title: string
  start_date: string
  end_date: string
  /** Row's project (for the "Hide projects" filter at the row level) */
  project_id?: number
  /** Row's owner (for the "Only mine" filter at the row level) */
  owner_id?: number
  resources?: PdfGanttResource[]
}

export interface PdfGanttMilestone {
  id?: number | string
  title: string
  date: string
}

export interface PdfGanttGroup {
  id?: number | string
  code?: string
  title: string
  start_date?: string
  end_date?: string
  /** Group's project (for the "Hide projects" filter at the group level) */
  project_id?: number
  /** Group's owner (for the "Only mine" filter at the group level) */
  owner_id?: number
  rows: PdfGanttRow[]
  milestones?: PdfGanttMilestone[]
}

/** Resource availability period (as in /timesheet/calendar) */
export interface PdfGanttAvailabilityPeriod {
  start_date: string
  end_date: string
  /** Maximum resource quantity for this period (active − absent) */
  available: number
}

/** Resource for the usage block (like ResourceHeader on screen) */
export interface PdfGanttResourceInfo {
  id: number
  code: string
  title?: string
  /** Availability periods from /timesheet/calendar — account for the timesheet and hire/fire dates */
  periods?: PdfGanttAvailabilityPeriod[]
}

export interface PdfGanttOptions {
  /** Start of the print range YYYY-MM-DD (inclusive) */
  from: string
  /** End of the print range YYYY-MM-DD (inclusive) */
  to: string
  /** Timeline anchor: the cell with index 0 */
  origin: Date | string
  /** Cell unit: day or decade */
  unit: PlanningUnit
  /** Title in the footer */
  pageTitle?: string
  /** Print scale (page zoom Ctrl+wheel): content density multiplier */
  scale?: number
  /** Row thickness in screen px (default 26); bar = row − 2px */
  rowHeight?: number
  /** Whether to draw the milestone strip and flags (default true) */
  showMilestones?: boolean
  /** Whether to draw the "today" line (default true) */
  showTodayLine?: boolean
  /** Drawing style: color (as on screen) or black-and-white outline */
  style?: 'color' | 'mono'
  /** Resources for the usage block under the calendar header */
  resources?: PdfGanttResourceInfo[]
}

/**
 * PDF render result: the document bytes plus a flag that the print range was
 * wider than the column capacity of one page width and its tail was cut
 * (only the initial part of the range is printed).
 */
export interface PdfGanttRenderResult extends Uint8Array {
  truncated: boolean
}

/** Shared empty per-resource usage map (read-only outside the precompute) */
const NO_RESOURCE_USAGE: ReadonlyMap<number, number> = new Map<number, number>()

/** Module-level font cache: loaded once, embedded into each document */
let fontBytesCache: { regular: Uint8Array; bold: Uint8Array } | null = null

async function loadFontBytes(): Promise<{ regular: Uint8Array; bold: Uint8Array }> {
  if (fontBytesCache) return fontBytesCache
  const [regular, bold] = await Promise.all([
    fetch(robotoRegularUrl).then((r) => r.arrayBuffer()),
    fetch(robotoBoldUrl).then((r) => r.arrayBuffer()),
  ])
  fontBytesCache = { regular: new Uint8Array(regular), bold: new Uint8Array(bold) }
  return fontBytesCache
}

interface DrawCtx {
  page: PDFPage
  font: PDFFont
  bold: PDFFont
  unit: PlanningUnit
  origin: Date | string
  cellW: number
  headerH: number
  contentW: number
  /** Milestone strip height in a group (0 if milestones are hidden) */
  stripH: number
  /** Precomputed resource usage (P-08): resource id → day index → total quantity.
   *  Built once per render — page loops only read visible-cell values. */
  usage: Map<number, Map<number, number>>
  /** Content top on the page: calendar header + resource block (pt) */
  groupsStart: number
  /** Print scale (page zoom): multiplier of content sizes */
  z: number
  /** Content sizes, scaled by z */
  layout: PdfLayout
  /** Palette of the current style (color / mono) */
  palette: Palette
  /** Interface language of the generation run (resolved once per render) */
  locale: AppLocale
}

/** Diagram content sizes (pt), already multiplied by scale z */
interface PdfLayout {
  rowH: number
  barH: number
  msStripH: number
  minGroupH: number
  monthRowH: number
  numRowH: number
  wdRowH: number
  rsRowH: number
}

/** pdf y for a top-y (coordinates from the page top, accounting for the margin) */
const pdfY = (top: number): number => PAGE_H - MARGIN - top

/** Rounded rectangle path in SVG coordinates (y down; r — corner radii) */
function roundedRectPath(
  w: number,
  h: number,
  r: { tl: number; tr: number; br: number; bl: number },
): string {
  const rad = (v: number) => Math.max(0, Math.min(v, w / 2, h / 2))
  const tl = rad(r.tl)
  const tr = rad(r.tr)
  const br = rad(r.br)
  const bl = rad(r.bl)
  return (
    `M ${tl},0 L ${w - tr},0 Q ${w},0 ${w},${tr} ` +
    `L ${w},${h - br} Q ${w},${h} ${w - br},${h} ` +
    `L ${bl},${h} Q 0,${h} 0,${h - bl} ` +
    `L 0,${tl} Q 0,0 ${tl},0 Z`
  )
}

/** Rounded rectangle: top — coordinate from the page top (like drawRectangle) */
function drawRoundedRect(
  page: PDFPage,
  opts: {
    x: number
    top: number
    w: number
    h: number
    r: number | { tl: number; tr: number; br: number; bl: number }
    color: Color
    opacity?: number
    borderColor?: Color
    borderWidth?: number
  },
) {
  const r = typeof opts.r === 'number' ? { tl: opts.r, tr: opts.r, br: opts.r, bl: opts.r } : opts.r
  page.drawSvgPath(roundedRectPath(opts.w, opts.h, r), {
    x: opts.x,
    y: pdfY(opts.top),
    color: opts.color,
    opacity: opts.opacity,
    borderColor: opts.borderColor,
    borderWidth: opts.borderWidth,
  })
}

/** pdf y of the baseline of text centered in the band [bandTop, bandTop+bandH] */
const textY = (bandTop: number, bandH: number, size: number): number =>
  pdfY(bandTop + (bandH - size) / 2 + size * 0.8)

/** pdf y of the baseline of text centered on the vertical axis center */
const centerTextY = (center: number, size: number): number => pdfY(center + size * 0.8 - size / 2)

/** Truncates text with an ellipsis to maxWidth */
function truncate(font: PDFFont, text: string, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text
  let out = text
  while (out.length > 1 && font.widthOfTextAtSize(out + '…', size) > maxWidth) {
    out = out.slice(0, -1)
  }
  return out + '…'
}

/** Cell number label: for a day — the number; for a decade — the day range (1-10, 11-20, 21-end) */
function numLabel(origin: Date | string, unit: PlanningUnit, i: number): string {
  const s = cellStartDate(origin, unit, i)
  const e = cellEndDate(origin, unit, i)
  return s.getDate() === e.getDate() ? String(s.getDate()) : `${s.getDate()}-${e.getDate()}`
}

function monthLabel(d: Date, locale: AppLocale): string {
  const m = fmtMonthLong(d, locale)
  return m.charAt(0).toUpperCase() + m.slice(1) + ' ' + d.getFullYear()
}

/** Cell's month in absolute count (for merging month bands) */
function monthKey(origin: Date | string, unit: PlanningUnit, i: number): number {
  const d = cellStartDate(origin, unit, i)
  return d.getFullYear() * 12 + d.getMonth()
}

interface GroupLayout {
  group: PdfGanttGroup
  top: number
  height: number
  /** Milestone strip height inside this group (0 — milestones hidden) */
  stripH: number
}

/**
 * One-pass precompute of the daily resource load over the print range (P-08):
 * resource id → absolute day index → total quantity assigned that day.
 * Rows are clipped to the cells of the (possibly truncated) range; days iterate
 * as calendar dates (DST-safe), matching the per-day loop in drawResourceHeader.
 * Equivalent to the previous per-day usageForDay scan, so the peak per cell
 * is unchanged — page loops only read ready values now.
 */
function computeResourceUsage(
  groups: PdfGanttGroup[],
  origin: Date | string,
  unit: PlanningUnit,
  fromCell: number,
  toCell: number,
): Map<number, Map<number, number>> {
  const usage = new Map<number, Map<number, number>>()
  const firstT = cellStartDate(origin, unit, fromCell).getTime()
  const lastT = cellEndDate(origin, unit, toCell).getTime()
  for (const g of groups) {
    for (const row of g.rows ?? []) {
      const s = toDate(row.start_date).getTime()
      const e = toDate(row.end_date).getTime()
      if (Number.isNaN(s) || Number.isNaN(e)) continue
      const d0 = new Date(Math.max(s, firstT))
      const d1 = Math.min(e, lastT)
      if (d1 < d0.getTime()) continue
      const assignments: { id: number; q: number }[] = []
      for (const r of row.resources ?? []) {
        const id = r.id
        const q = r.quantity ?? 0
        if (id != null && q !== 0) assignments.push({ id, q })
      }
      if (!assignments.length) continue
      const cur = new Date(d0)
      while (cur.getTime() <= d1) {
        const di = cellIndexForDate(origin, 'day', cur)
        for (const a of assignments) {
          let m = usage.get(a.id)
          if (!m) {
            m = new Map()
            usage.set(a.id, m)
          }
          m.set(di, (m.get(di) ?? 0) + a.q)
        }
        cur.setDate(cur.getDate() + 1)
      }
    }
  }
  return usage
}

/** Resource availability for the day from /timesheet/calendar periods (null — no coverage) */
function availableForDay(r: PdfGanttResourceInfo, day: Date): number | null {
  const periods = r.periods
  if (!periods || !periods.length) return null
  const iso = fmtDate(day)
  for (const p of periods) {
    if (p.start_date && p.end_date && iso >= p.start_date && iso <= p.end_date) {
      return p.available ?? 0
    }
  }
  return null
}

/**
 * Resource usage block (like ResourceHeader): one row per resource below the calendar
 * header, the code in the label column, per cell — the peak load over the cell's days
 * colored by state (normal/overload/critical/weekend/no data).
 */
function drawResourceHeader(
  ctx: DrawCtx,
  resources: PdfGanttResourceInfo[],
  colFrom: number,
  colTo: number,
) {
  const { page, font, bold, unit, origin, cellW, headerH, usage, layout, z, palette } = ctx
  const yTop = headerH
  const height = resources.length * layout.rsRowH

  // Label column: white backdrop + resource codes
  page.drawRectangle({ x: MARGIN, y: pdfY(yTop + height), width: labelW, height, color: palette.labelBg })
  for (let ri = 0; ri < resources.length; ri++) {
    const r = resources[ri]
    const top = yTop + ri * layout.rsRowH
    page.drawText(truncate(bold, r.code, 9 * z, labelW - 14), {
      x: MARGIN + 6,
      y: textY(top, layout.rsRowH, 9 * z),
      size: 9 * z,
      font: bold,
      color: palette.textMain,
    })
  }
  page.drawLine({
    start: { x: MARGIN + labelW, y: pdfY(yTop) },
    end: { x: MARGIN + labelW, y: pdfY(yTop + height) },
    thickness: 0.75,
    color: palette.labelLine,
  })

  // Usage cells across the visible indices
  for (let ri = 0; ri < resources.length; ri++) {
    const r = resources[ri]
    const dayUsage = usage.get(r.id) ?? NO_RESOURCE_USAGE
    const top = yTop + ri * layout.rsRowH
    for (let k = colFrom; k <= colTo; k++) {
      const x = MARGIN + labelW + (k - colFrom) * cellW
      const start = cellStartDate(origin, unit, k)
      const end = cellEndDate(origin, unit, k)
      let peak = 0
      let weekend = true
      let minAvail: number | null = null
      let hasUnknown = false
      const cur = new Date(start)
      while (cur <= end) {
        const wd = cur.getDay() === 0 || cur.getDay() === 6
        if (!wd) weekend = false
        // Ready value from the one-pass precompute — no group/row scans per day
        peak = Math.max(peak, dayUsage.get(cellIndexForDate(origin, 'day', cur)) ?? 0)
        const availDay = availableForDay(r, cur)
        if (availDay == null) hasUnknown = true
        else minAvail = minAvail == null ? availDay : Math.min(minAvail, availDay)
        cur.setDate(cur.getDate() + 1)
      }
      // Cell availability as in the planner: minimum over days; if any day has
      // no period — the state is "no data"
      const avail = hasUnknown ? null : minAvail
      // State by load percentage, as in UsageCell: ≤100% normal, up to 160%
      // overload, >160% critical (0 available with load — critical)
      let state: 'normal' | 'warn' | 'critical' | 'weekend' | 'unknown'
      if (weekend) state = 'weekend'
      else if (avail == null) state = 'unknown'
      else if (avail === 0) state = peak > 0 ? 'critical' : 'normal'
      else {
        const pct = (peak / avail) * 100
        state = pct <= 100 ? 'normal' : pct <= 160 ? 'warn' : 'critical'
      }
      const bg =
        state === 'weekend'
          ? palette.usageWeekend
          : state === 'unknown'
            ? palette.usageUnknown
            : state === 'warn'
              ? palette.usageWarn
              : state === 'critical'
                ? palette.usageCritical
                : palette.usageNormal
      page.drawRectangle({ x, y: pdfY(top + layout.rsRowH), width: cellW, height: layout.rsRowH, color: bg })
      // Usage numbers: adaptive font — starts from the scale (6.75×z) and the cell
      // width, shrinks when space is tight so that "used/cap" fits
      // (at low zoom the font is smaller — numbers stay visible even in narrow cells).
      const label = avail == null ? `${peak}` : `${peak}/${avail}`
      let size = Math.min(6.75 * z, cellW * 0.6)
      while (size >= 1.5 && font.widthOfTextAtSize(label, size) > cellW - 1) size -= 0.25
      if (size >= 1.5) {
        const tw = font.widthOfTextAtSize(label, size)
        const textColor =
          state === 'weekend' || state === 'unknown' ? palette.textFaint : palette.usageText
        page.drawText(label, {
          x: x + (cellW - tw) / 2,
          y: textY(top, layout.rsRowH, size),
          size,
          font: bold,
          color: textColor,
        })
      }
    }
    // Resource row divider
    page.drawLine({
      start: { x: MARGIN + labelW, y: pdfY(top + layout.rsRowH) },
      end: { x: MARGIN + labelW + (colTo - colFrom + 1) * cellW, y: pdfY(top + layout.rsRowH) },
      thickness: 0.4,
      color: palette.gridLine,
    })
  }
}

/** Draws the calendar header: month/numbers/weekdays + cell borders */
function drawHeader(ctx: DrawCtx, colFrom: number, colTo: number, cellWidthPx: number) {
  const { page, font, bold, unit, cellW, headerH, contentW, layout, z, palette, locale } = ctx
  const bands: { top: number; h: number }[] = [{ top: 0, h: layout.monthRowH }]
  const showNumRow = cellWidthPx >= (unit === 'day' ? CELL_PX_NUM_DAY : CELL_PX_NUM_DECADE)
  const showWdRow = unit === 'day' && cellWidthPx >= CELL_PX_WD_DAY
  if (showNumRow) bands.push({ top: layout.monthRowH, h: layout.numRowH })
  if (showWdRow) bands.push({ top: layout.monthRowH + layout.numRowH, h: layout.wdRowH })

  page.drawRectangle({ x: MARGIN, y: pdfY(headerH), width: contentW, height: headerH, color: palette.headerBg })

  // Vertical cell borders in the header
  for (let k = colFrom; k <= colTo + 1; k++) {
    const x = MARGIN + labelW + (k - colFrom) * cellW
    page.drawLine({ start: { x, y: pdfY(0) }, end: { x, y: pdfY(headerH) }, thickness: 0.5, color: palette.headerLine })
  }

  // Month bands: the label is centered over the visible part of the month; with narrow
  // cells the font size shrinks so the month name stays readable
  let i = colFrom
  while (i <= colTo) {
    const key = monthKey(ctx.origin, unit, i)
    let j = i
    while (j <= colTo && monthKey(ctx.origin, unit, j) === key) j++
    const x0 = MARGIN + labelW + (i - colFrom) * cellW
    const x1 = MARGIN + labelW + (j - colFrom) * cellW
    const label = monthLabel(cellStartDate(ctx.origin, unit, i), locale)
    const maxW = Math.max(x1 - x0 - 2, 6)
    let size = 8.25 * z
    while (size > 4.5 * z && bold.widthOfTextAtSize(label, size) > maxW) size -= 0.5 * z
    const text = truncate(bold, label, size, maxW)
    const tw = bold.widthOfTextAtSize(text, size)
    page.drawText(text, {
      x: x0 + (x1 - x0 - tw) / 2,
      y: textY(0, layout.monthRowH, size),
      size,
      font: bold,
      color: palette.textHeader,
    })
    i = j
  }

  // Numbers and weekdays per cell
  if (showNumRow) {
    for (let k = colFrom; k <= colTo; k++) {
      const x = MARGIN + labelW + (k - colFrom) * cellW
      const label = numLabel(ctx.origin, unit, k)
      const size = 7.5 * z
      const tw = font.widthOfTextAtSize(label, size)
      if (tw <= cellW - 2) {
        page.drawText(label, { x: x + (cellW - tw) / 2, y: textY(layout.monthRowH, layout.numRowH, size), size, font, color: palette.textHeaderNum })
      }
    }
  }
  if (showWdRow) {
    // Weekday names follow the interface language active at generation time
    const dowMap = weekdayShort(locale)
    for (let k = colFrom; k <= colTo; k++) {
      const x = MARGIN + labelW + (k - colFrom) * cellW
      const label = dowMap[cellStartDate(ctx.origin, unit, k).getDay()]
      const size = 7.5 * z
      const tw = font.widthOfTextAtSize(label, size)
      if (tw <= cellW - 2) {
        page.drawText(label, {
          x: x + (cellW - tw) / 2,
          y: textY(layout.monthRowH + layout.numRowH, layout.wdRowH, size),
          size,
          font,
          color: palette.textFaint,
        })
      }
    }
  }

  // Header bottom border
  page.drawLine({ start: { x: MARGIN, y: pdfY(headerH) }, end: { x: MARGIN + contentW, y: pdfY(headerH) }, thickness: 0.75, color: palette.groupLine })
}

/** Vertical grid lines for the visible window (from the header to the table bottom) */
function drawGrid(ctx: DrawCtx, colFrom: number, colTo: number, winTop: number, winBottom: number) {
  const { page, cellW, headerH, palette } = ctx
  for (let k = colFrom; k <= colTo + 1; k++) {
    const x = MARGIN + labelW + (k - colFrom) * cellW
    page.drawLine({
      start: { x, y: pdfY(headerH) },
      end: { x, y: pdfY(winBottom - winTop) },
      thickness: 0.4,
      color: palette.gridLine,
    })
  }
}

/** Draws a group (milestone strip, merged label, task bars), clipped to the visible window */
function drawGroup(ctx: DrawCtx, gl: GroupLayout, colFrom: number, colTo: number, winTop: number, winBottom: number) {
  const { page, font, bold, unit, cellW, groupsStart, layout, z, palette, locale } = ctx
  const g = gl.group
  const strip = gl.stripH
  const top = gl.top
  const bottom = top + gl.height
  // Top of the visible slice: content below the header and the resource block (page-local = y - winTop)
  const clipTop = winTop + groupsStart
  const visibleTop = Math.max(top, clipTop)
  const visibleBottom = Math.min(bottom, winBottom)
  if (visibleTop >= visibleBottom) return

  const x0 = MARGIN + labelW
  const x1 = MARGIN + labelW + (colTo - colFrom + 1) * cellW

  // Group bounds backdrop (like .gg-overlay) across the actual date span
  const s = cellRangeForSpanSafe(ctx.origin, unit, g.start_date, g.end_date)
  if (s) {
    const ox = Math.max(x0, MARGIN + labelW + (Math.max(s.startCell, colFrom) - colFrom) * cellW)
    const ox1 = Math.min(x1, MARGIN + labelW + (Math.min(s.endCell, colTo + 1) - colFrom) * cellW)
    if (ox1 - ox > 0) {
      page.drawRectangle({
        x: ox,
        y: pdfY(visibleBottom - winTop),
        width: ox1 - ox,
        height: visibleBottom - visibleTop,
        color: palette.groupTint,
        opacity: palette.groupTintOpacity,
      })
    }
  }

  // Group merged label (code + name + dates). Text is drawn only on the first
  // page of the group (labelTop visible in the slice): on continuations — a white
  // backdrop and border, so the process description "cell" is not duplicated.
  const labelTop = top + strip
  const labelBottom = bottom
  const lvTop = Math.max(labelTop, clipTop)
  const lvBottom = Math.min(labelBottom, winBottom)
  const showLabelText = labelTop >= clipTop
  if (lvTop < lvBottom) {
    page.drawRectangle({ x: MARGIN, y: pdfY(lvBottom - winTop), width: labelW, height: lvBottom - lvTop, color: palette.labelBg })
    const padX = 9
    const maxW = labelW - padX * 2
    let cursor = lvTop - winTop + 3
    if (showLabelText && g.code) {
      const size = 12 * z
      page.drawText(truncate(bold, g.code, size, maxW), { x: MARGIN + padX, y: pdfY(cursor + size * 0.8), size, font: bold, color: palette.codeText })
      cursor += size * 1.3
    }
    if (showLabelText) {
      const titleSize = 9 * z
      page.drawText(truncate(bold, g.title, titleSize, maxW), { x: MARGIN + padX, y: pdfY(cursor + titleSize * 0.8), size: titleSize, font: bold, color: palette.groupTitle })
      cursor += titleSize * 1.3
      if (g.start_date && g.end_date) {
        const dSize = 7.5 * z
        const range = fmtDateRange(toDate(g.start_date), toDate(g.end_date), locale)
        page.drawText(truncate(font, range, dSize, maxW), { x: MARGIN + padX, y: pdfY(cursor + dSize * 0.8), size: dSize, font, color: palette.textDim })
      }
    }
    // Label borders
    page.drawLine({ start: { x: MARGIN + labelW, y: pdfY(lvBottom - winTop) }, end: { x: MARGIN + labelW, y: pdfY(lvTop - winTop) }, thickness: 0.75, color: palette.labelLine })
  }

  // Task bars
  const rows = g.rows ?? []
  for (let i = 0; i < rows.length; i++) {
    const bandTop = top + strip + i * layout.rowH
    if (bandTop >= winBottom || bandTop + layout.rowH <= clipTop) continue
    const row = rows[i]
    const span = cellRangeForSpanSafe(ctx.origin, unit, row.start_date, row.end_date)
    if (!span) continue
    const barX = MARGIN + labelW + (span.startCell - colFrom) * cellW
    const barX1 = MARGIN + labelW + (span.endCell - colFrom) * cellW
    const bx = Math.max(barX, x0)
    const bx1 = Math.min(barX1, x1)
    if (bx1 - bx <= 0) continue
    // Vertical clip of the bar to the visible slice (boundary group at a page seam):
    // clipTop — in page-local coordinates (groupsStart), the bottom — winBottom - winTop
    const barTopLocal = bandTop - winTop + (layout.rowH - layout.barH) / 2
    const barBottomLocal = barTopLocal + layout.barH
    const barTopClip = Math.max(barTopLocal, groupsStart)
    const barBottomClip = Math.min(barBottomLocal, winBottom - winTop)
    if (barBottomClip - barTopClip <= 0) continue
    const barFull = barTopClip === barTopLocal && barBottomClip === barBottomLocal
    // Rounding as on screen (5px), but without a radius on the clipped side
    // at page seams (otherwise the corner "bulges" past the edge).
    const topClipped = barTopClip > barTopLocal
    const bottomClipped = barBottomClip < barBottomLocal
    const barRad = Math.min(5 * PT * z, (bx1 - bx) / 2, (barBottomClip - barTopClip) / 2)
    drawRoundedRect(page, {
      x: bx,
      top: barTopClip,
      w: bx1 - bx,
      h: barBottomClip - barTopClip,
      r: {
        tl: topClipped ? 0 : barRad,
        tr: topClipped ? 0 : barRad,
        br: bottomClipped ? 0 : barRad,
        bl: bottomClipped ? 0 : barRad,
      },
      color: palette.bar,
      opacity: palette.barOpacity,
      borderColor: palette.barBorder,
      borderWidth: palette.barBorderWidth,
    })

    // Bar text: title + code badge + resource badges (only when the bar is not clipped)
    const pad = 6
    const barCenter = (barTopClip + barBottomClip) / 2
    if (barFull && bx1 - bx >= pad * 2 + 10) {
      const size = 9 * z
      let cx = bx + pad
      const avail = bx1 - bx - pad * 2
      const title = truncate(bold, row.title, size, avail)
      const tw = bold.widthOfTextAtSize(title, size)
      page.drawText(title, { x: cx, y: centerTextY(barCenter, size), size, font: bold, color: palette.barText })
      cx += tw + 4.5

      const bh = 12 * z
      // Pill as on screen (radius 10px), limited by the height
      const badgeRad = Math.min(10 * PT * z, bh / 2)
      const drawBadge = (text: string, cs: number, bg: Color, opacity: number, border?: Color, borderWidth = 0) => {
        const w = bold.widthOfTextAtSize(text, cs) + 8
        const topBadge = barCenter - bh / 2
        drawRoundedRect(page, { x: cx, top: topBadge, w, h: bh, r: badgeRad, color: bg, opacity, borderColor: border, borderWidth })
        page.drawText(text, { x: cx + 4, y: centerTextY(barCenter, cs), size: cs, font: bold, color: palette.badgeText })
        cx += w + 4.5
      }

      // Project code badge, if there is room
      if (g.code && cx + 12 < bx1 - pad) {
        const cs = 7.5 * z
        const codeText = truncate(bold, g.code, cs, bx1 - pad - cx - 8)
        if (bold.widthOfTextAtSize(codeText, cs) + 12 <= bx1 - pad - cx) {
          drawBadge(codeText, cs, palette.codeBadgeBg, palette.codeBadgeOpacity, palette.badgeBorder, palette.badgeBorderWidth)
        }
      }
      // Resource badges while there is room
      for (const r of row.resources ?? []) {
        if (cx + 14 >= bx1 - pad) break
        const cs = 7.5 * z
        const label = `${r.code || r.title || '?'}×${r.quantity ?? 1}`
        const text = truncate(bold, label, cs, bx1 - pad - cx - 8)
        if (bold.widthOfTextAtSize(text, cs) + 12 > bx1 - pad - cx) break
        drawBadge(text, cs, palette.resBadgeBg, palette.resBadgeOpacity, palette.badgeBorder, palette.badgeBorderWidth)
      }
    }
  }

  // Milestones: a flag in the strip + a ray down the group. Drawn AFTER the bars so the ray
  // is on top of them. The strip must fit entirely in the visible slice (otherwise the flag
  // ends up under the header/in the page margin).
  if (strip > 0 && top >= clipTop && top + strip <= winBottom) {
    const rayStart = (top - winTop) + strip
    const rayEnd = Math.min(bottom - winTop, winBottom - winTop)
    for (const ms of g.milestones ?? []) {
      if (!ms.date) continue
      const idx = cellIndexForDate(ctx.origin, unit, ms.date)
      if (idx < colFrom || idx > colTo) continue
      const cx = MARGIN + labelW + (idx - colFrom) * cellW + cellW / 2
      const flagW = Math.max(cellW * 0.5, 3 * z)
      const flagH = 12 * z
      const fx = cx - flagW / 2
      const flagTop = top - winTop + 1.5 * z
      // 4px rounding, like .ms-marker on screen (limited by the flag size)
      const flagRad = Math.min(4 * PT * z, flagW / 2, flagH / 2)
      drawRoundedRect(page, { x: fx, top: flagTop, w: flagW, h: flagH, r: flagRad, color: palette.ms, opacity: 1, borderColor: palette.msBorder, borderWidth: palette.msBorderWidth })
      // Ray from the milestone strip to the group bottom (clipped by the slice bottom)
      page.drawLine({
        start: { x: cx, y: pdfY(rayStart) },
        end: { x: cx, y: pdfY(rayEnd) },
        thickness: 1.5 * z,
        color: palette.msRay,
        opacity: palette.msOpacity,
      })
    }
  }
}

/** Span of a date interval in cells; null if the dates are invalid */
function cellRangeForSpanSafe(
  origin: Date | string,
  unit: PlanningUnit,
  start?: string,
  end?: string,
): { startCell: number; endCell: number } | null {
  if (!start || !end) return null
  const s = toDate(start).getTime()
  const e = toDate(end).getTime()
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null
  return {
    startCell: cellIndexForDate(origin, unit, start),
    endCell: Math.max(cellIndexForDate(origin, unit, end) + 1, cellIndexForDate(origin, unit, start) + 1),
  }
}

/** Red "today" line in the visible window — at the "yesterday/today" boundary, as in the planner */
function drawToday(ctx: DrawCtx, colFrom: number, colTo: number, winTop: number, winBottom: number) {
  const idx = cellIndexForDate(ctx.origin, ctx.unit, new Date())
  if (idx < colFrom || idx > colTo) return
  const now = new Date()
  const s = cellStartDate(ctx.origin, ctx.unit, idx).getTime()
  const e = cellEndDate(ctx.origin, ctx.unit, idx).getTime()
  // day — the left edge of the "today" cell; decade — the fractional position of the current day
  const frac = ctx.unit === 'decade' ? (now.getTime() - s) / (e - s + DAY_MS) : 0
  const x = MARGIN + labelW + (idx - colFrom) * ctx.cellW + frac * ctx.cellW
  ctx.page.drawLine({
    start: { x, y: pdfY(ctx.headerH) },
    end: { x, y: pdfY(winBottom - winTop) },
    thickness: 1.5,
    color: ctx.palette.today,
    opacity: ctx.palette.todayOpacity,
  })
}

function drawFooter(page: PDFPage, font: PDFFont, bold: PDFFont, pageNo: number, pageCount: number, opts: PdfGanttOptions, palette: Palette, locale: AppLocale) {
  const y = MARGIN + FOOTER_H
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE_W - MARGIN, y }, thickness: 0.5, color: palette.gridLine })
  const size = 7.5
  const title = opts.pageTitle ?? ''
  const range = fmtDateRange(toDate(opts.from), toDate(opts.to), locale)
  page.drawText(title, { x: MARGIN, y: y - size * 1.1, size, font: bold, color: palette.textDim })
  page.drawText(range, { x: MARGIN + bold.widthOfTextAtSize(title, size) + 12, y: y - size * 1.1, size, font, color: palette.textFaint })
  const pg = t('pdf.render.page', { page: pageNo, total: pageCount })
  const pw = font.widthOfTextAtSize(pg, size)
  page.drawText(pg, { x: PAGE_W - MARGIN - pw, y: y - size * 1.1, size, font, color: palette.textDim })
}

/**
 * Renders the Gantt diagram to PDF.
 * Returns the PDF file bytes with a `truncated` flag (P-07): when the date range
 * exceeds the column capacity of one page width, only its initial part is printed.
 */
export async function renderGanttPdf(groups: PdfGanttGroup[], opts: PdfGanttOptions): Promise<PdfGanttRenderResult> {
  // Resolve the language at generation time: the renderer may be called long
  // after a language switch, so nothing here may be captured at module scope.
  const locale = currentLocale()
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const bytes = await loadFontBytes()
  // subset:false — pdf-lib 1.17.1 subsetting produces a broken separate subset per
  // drawText (text disappears in the render). The full font embeds correctly.
  const font = await doc.embedFont(bytes.regular, { subset: false })
  const bold = await doc.embedFont(bytes.bold, { subset: false })

  const unit = opts.unit
  /** Print scale: page zoom (Ctrl+wheel) — content density multiplier */
  const z = Math.max(0.25, Math.min(4, opts.scale ?? 1))
  /** Style palette: color (default) or black-and-white outline */
  const palette = buildPalette(opts.style)
  /** Row thickness (screen px); the bar is 2px thinner than the row */
  const rowHeightPx = opts.rowHeight ?? 26
  const layout: PdfLayout = {
    rowH: rowHeightPx * PT * z,
    barH: Math.max(rowHeightPx - 2, 4) * PT * z,
    msStripH: msStripH * z,
    minGroupH: minGroupH * z,
    monthRowH: monthRowH * z,
    numRowH: numRowH * z,
    wdRowH: wdRowH * z,
    rsRowH: rsRowH * z,
  }
  const fromCell = cellIndexForDate(opts.origin, unit, opts.from)
  const toCell = Math.max(fromCell, cellIndexForDate(opts.origin, unit, opts.to))
  const totalCells = toCell - fromCell + 1

  const contentW = PAGE_W - 2 * MARGIN
  /** Column capacity of one page width at the minimum cell width (P-07) */
  const maxCells = Math.max(1, Math.floor((contentW - labelW) / MIN_CELL_W))
  /** The range is wider than the page — cut the tail; the initial part is printed */
  const truncated = totalCells > maxCells
  /** Effective end of the printed range (exclusive of cells beyond the page width) */
  const effToCell = truncated ? fromCell + maxCells - 1 : toCell
  const effTotal = Math.min(totalCells, maxCells)
  /** Cell width to fit the (possibly truncated) range on one page: >= MIN_CELL_W */
  const cellW = (contentW - labelW) / effTotal
  /** Effective "screen" cell width for header thresholds */
  const cellWidthPx = cellW / PT
  const headerH = headerHeight(unit, cellWidthPx) * PT * z
  /** The whole range on one page across the width (no horizontal pagination) */
  const pagesAcross = 1

  // Processes lying entirely outside the print range are excluded from rendering
  // altogether: start_date >= right boundary or end_date <= left boundary.
  // Without dates (or with broken ones) the process stays — rendering relies on tasks.
  const fromTime = toDate(opts.from).getTime()
  const toTime = toDate(opts.to).getTime()
  const groupsInRange = groups.filter((g) => {
    if (!g.start_date || !g.end_date) return true
    const s = toDate(g.start_date).getTime()
    const e = toDate(g.end_date).getTime()
    if (Number.isNaN(s) || Number.isNaN(e)) return true
    return s < toTime && e > fromTime
  })

  /** Milestone strip: 0 if milestones are hidden by the print option */
  const stripH = opts.showMilestones === false ? 0 : layout.msStripH
  /** Resources for the usage block (empty — the block is not drawn) */
  const resources = opts.resources ?? []
  /** One-pass per-resource daily load over the effective range (P-08):
   *  page loops only read ready values for visible cells */
  const usage = resources.length
    ? computeResourceUsage(groupsInRange, opts.origin, unit, fromCell, effToCell)
    : new Map<number, Map<number, number>>()

  // Groups in "own" coordinates (0 = right below the header/resources)
  const layouts: GroupLayout[] = []
  let top = 0
  for (const g of groupsInRange) {
    const height = stripH + Math.max((g.rows ?? []).length * layout.rowH, layout.minGroupH)
    layouts.push({ group: g, top, height, stripH })
    top += height
  }
  const tableH = top
  const tableBottom = PAGE_H - MARGIN - FOOTER_H
  const availH = tableBottom - MARGIN
  const resourcesH = resources.length * layout.rsRowH
  /** Content top on the page: calendar header + resource block */
  const groupsStart = headerH + resourcesH
  /** Page height available for groups (after the header and resources) */
  const groupsAvail = Math.max(availH - groupsStart, 50)

  // Page breaks ONLY at row boundaries: a page fits whole rows,
  // otherwise the last row (and its bar) would move entirely to the next page.
  const rowTops: number[] = []
  for (const gl of layouts) {
    const rowsCount = (gl.group.rows ?? []).length
    for (let i = 0; i < rowsCount; i++) rowTops.push(gl.top + gl.stripH + i * layout.rowH)
  }
  const pageBreaks: number[] = []
  {
    let start = 0
    while (start < tableH) {
      pageBreaks.push(start)
      const limit = start + groupsAvail
      let end = start
      for (const t of rowTops) {
        if (t >= start && t + layout.rowH <= limit && t + layout.rowH > end) {
          end = t + layout.rowH
        }
      }
      // Safety net: no row "fit" — cut by pixel height
      if (end <= start) end = Math.min(start + groupsAvail, tableH)
      start = end
    }
  }
  // Trailing empty page: if after the last row only the min-group height is left
  // (the last group is shorter than its rows), the rows end before tableH —
  // we remove the extra page breaks.
  if (rowTops.length > 0) {
    const rowsEnd = Math.max(...rowTops) + layout.rowH
    while (pageBreaks.length > 1 && pageBreaks[pageBreaks.length - 1] >= rowsEnd) pageBreaks.pop()
  }
  const pagesDown = pageBreaks.length

  for (let r = 0; r < pagesDown; r++) {
    for (let c = 0; c < pagesAcross; c++) {
      const page = doc.addPage([PAGE_W, PAGE_H])
      const ctx: DrawCtx = {
        page,
        font,
        bold,
        unit,
        origin: opts.origin,
        cellW,
        headerH,
        contentW,
        stripH,
        usage,
        groupsStart,
        z,
        layout,
        palette,
        locale,
      }
      // Absolute cell indices: the (possibly truncated) range — one page across the width.
      const colFrom = fromCell
      const colTo = effToCell
      // Vertical pagination at row boundaries: winTop is shifted by groupsStart
      // so the first visible group slice starts BELOW the header and the resource block;
      // winBottom — the slice boundary (end of the last full row).
      const start = pageBreaks[r]
      const end = r + 1 < pagesDown ? pageBreaks[r + 1] : tableH
      const winTop = start - groupsStart
      const winBottom = end

      drawHeader(ctx, colFrom, colTo, cellWidthPx)
      drawGrid(ctx, colFrom, colTo, winTop, winBottom)
      if (resources.length) drawResourceHeader(ctx, resources, colFrom, colTo)
      for (const gl of layouts) drawGroup(ctx, gl, colFrom, colTo, winTop, winBottom)

      // Group dividers across the full table width (only in the visible slice below the header)
      for (const gl of layouts) {
        const y = gl.top + gl.height
        if (y <= winTop + groupsStart || y >= winBottom) continue
        page.drawLine({
          start: { x: MARGIN + labelW, y: pdfY(y - winTop) },
          end: { x: MARGIN + contentW, y: pdfY(y - winTop) },
          thickness: 0.75,
          color: palette.groupLine,
        })
      }

      // The "today" line is drawn last — over the bars and milestone rays (as on screen);
      // it does not cross the label column (starts at x >= labelW)
      if (opts.showTodayLine !== false) drawToday(ctx, colFrom, colTo, winTop, winBottom)

      drawFooter(page, font, bold, r * pagesAcross + c + 1, pagesDown * pagesAcross, opts, palette, locale)
    }
  }

  const pdfBytes = await doc.save()
  // The truncated flag rides on the bytes so existing Uint8Array consumers
  // (preview, download) work unchanged; PdfExport.vue reads it for the warning.
  const result = Object.assign(pdfBytes, { truncated })
  return result as PdfGanttRenderResult
}
