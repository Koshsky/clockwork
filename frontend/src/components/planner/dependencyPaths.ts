/**
 * Connector geometry of the task dependencies (fs/ss/ff/sf) for the Gantt
 * overlay. Six styles share the same endpoints and the same terminus tick, so
 * switching a style never moves a date — only the middle of the path changes:
 *
 *   - 'sharp':   orthogonal route with square corners;
 *   - 'rounded': the same route with small rounded corners (default);
 *   - 'smooth':  the same route with large rounded corners;
 *   - 's-curve': a single cubic Bézier with horizontal tangents at both ends;
 *   - 'hockey':  one cubic — leaves the predecessor vertically, enters the
 *                successor horizontally;
 *   - 'metro':   a 45° diagonal route with rounded corners.
 *
 * There is no dependency-type table here: the two endpoints already encode the
 * type through the engine helpers (see ./dependencies), so the drawing cannot
 * drift away from the constraint semantics:
 *   fs — predecessor's END edge   → successor's START edge
 *   ff — predecessor's END edge   → successor's END edge
 *   ss — predecessor's START edge → successor's START edge
 *   sf — predecessor's START edge → successor's END edge
 * Every style ends with a horizontal approach into the bound edge, so the tick
 * sits on the constrained date, perpendicular to the line — the reading is
 * "the link stops here".
 *
 * Pure logic (no Vue/DOM/store imports) — mirrored by dependencyPaths.test.ts.
 */
import { anchorIsStart, boundIsStart, type DependencyType } from './dependencies'
import { LINK_STYLE_DEFAULT, type LinkStyle } from './linkStyle'

export type { LinkStyle } from './linkStyle'

// --- s-curve constants ------------------------------------------------------

/** Smallest control-point offset (px): a short link stays a near-straight S. */
export const LINK_MIN_BULGE = 8
/** Largest entry-side offset (px) — long links keep a flat middle instead. */
export const LINK_MAX_BULGE = 120
/**
 * Largest exit-side offset (px). Deliberately shorter than the entry hook: a
 * long link leaves the predecessor outwards, and a full-length swing would
 * reach back over the sticky task labels on the left of the timeline.
 */
export const LINK_MAX_EXIT_BULGE = 48
/** Share of the horizontal anchor→bound span used as the control-point offset. */
export const LINK_BULGE_RATIO = 0.5
/** Share of the vertical span the hockey style covers before turning (0–1). */
export const HOCKEY_PULL = 0.55

// --- orthogonal constants ---------------------------------------------------

/** Exit stub out of the predecessor's edge (px). */
export const ELBOW_STUB = 8
/** Distance of the incoming vertical from the bound edge (px). */
export const ELBOW_APPROACH = 14
/** Corner radius of the default ('rounded') route (px). */
export const ELBOW_CORNER = 5
/** Corner radius of the 'smooth' route (px). */
export const SMOOTH_CORNER = 14
/** Corner radius of the 'metro' route (px). */
export const METRO_CORNER = 6
/**
 * Two verticals closer than this merge into one. Below the threshold the jog
 * would swing back over the predecessor's own bar (the "bars touch" layout of
 * a day-after-day plan is the common case), while a merged route becomes a
 * clean staircase.
 */
export const ELBOW_MIN_RUN = 24

/** Half-height of the terminus tick (px). */
export const LINK_TICK_HALF = 5.5

export interface LinkEndpoints {
  type: DependencyType
  /** Predecessor bar edges (container-local px) */
  predStartX: number
  predEndX: number
  /** Successor bar edges (container-local px) */
  succStartX: number
  succEndX: number
  /** Row centers (container-local px) */
  predY: number
  succY: number
}

export interface LinkArrow {
  /** `d` of the connector, ending exactly on the bound edge. */
  d: string
  /** `d` of the terminus tick, perpendicular to the incoming tangent. */
  tick: string
  /** The constrained point (the tick center), container-local px. */
  tipX: number
  tipY: number
}

interface Point {
  x: number
  y: number
}

/** Rounds to 2 decimals: path data stays free of float noise (tests, snapshots). */
function px(value: number): number {
  return Math.round(value * 100) / 100
}

/** Control-point offset of the curve between `anchorX` and `boundX`. */
export function linkBulge(anchorX: number, boundX: number, max = LINK_MAX_BULGE): number {
  const raw = Math.abs(boundX - anchorX) * LINK_BULGE_RATIO
  return Math.min(max, Math.max(LINK_MIN_BULGE, raw))
}

/** Drops consecutive duplicates (they appear where two verticals merge). */
function dedupe(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (!last || Math.abs(last.x - p.x) > 0.01 || Math.abs(last.y - p.y) > 0.01) out.push(p)
  }
  return out
}

/**
 * Polyline whose corners are rounded by quadratic Béziers (`radius` 0 keeps
 * them square). Zero-length line commands are skipped: on a short segment two
 * neighbouring corners can meet exactly, and a redundant `L` would only add
 * noise to the path data.
 */
function roundedPath(points: Point[], radius: number): string {
  const pts = dedupe(points)
  if (pts.length < 2) return ''
  let cur = pts[0]
  let d = `M ${px(cur.x)},${px(cur.y)}`
  const lineTo = (p: Point): void => {
    if (Math.abs(p.x - cur.x) < 0.01 && Math.abs(p.y - cur.y) < 0.01) return
    d += ` L ${px(p.x)},${px(p.y)}`
    cur = p
  }

  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1]
    const p1 = pts[i]
    const p2 = pts[i + 1]
    const v1x = p1.x - p0.x
    const v1y = p1.y - p0.y
    const v2x = p2.x - p1.x
    const v2y = p2.y - p1.y
    const l1 = Math.hypot(v1x, v1y)
    const l2 = Math.hypot(v2x, v2y)
    if (l1 < 0.5 || l2 < 0.5) continue
    // A radius that fits both adjacent segments, otherwise the corner stays square.
    const r = Math.min(radius, l1 / 2, l2 / 2)
    if (r < 0.5) {
      lineTo(p1)
      continue
    }
    const entry = { x: p1.x - (v1x / l1) * r, y: p1.y - (v1y / l1) * r }
    const exit = { x: p1.x + (v2x / l2) * r, y: p1.y + (v2y / l2) * r }
    lineTo(entry)
    d += ` Q ${px(p1.x)},${px(p1.y)} ${px(exit.x)},${px(exit.y)}`
    cur = exit
  }

  lineTo(pts[pts.length - 1])
  return d
}

/** Shared route of the orthogonal styles: exit → channel → bound row → bound. */
function elbowPoints(anchor: Point, outDir: number, bound: Point, inDir: number): Point[] {
  const yC = (anchor.y + bound.y) / 2
  const x1 = anchor.x + outDir * ELBOW_STUB
  let x2 = bound.x - inDir * ELBOW_APPROACH
  if (Math.abs(x2 - x1) < ELBOW_MIN_RUN) x2 = x1
  return [
    anchor,
    { x: x1, y: anchor.y },
    { x: x1, y: yC },
    { x: x2, y: yC },
    { x: x2, y: bound.y },
    bound,
  ]
}

/** Orthogonal route with the given corner radius (0 = square corners). */
function elbowPath(
  anchor: Point,
  outDir: number,
  bound: Point,
  inDir: number,
  radius: number,
): string {
  return roundedPath(elbowPoints(anchor, outDir, bound, inDir), radius)
}

/** S-curve: one cubic Bézier, leaving outwards and entering the bound edge. */
function sCurvePath(anchor: Point, outDir: number, bound: Point, inDir: number): string {
  const kOut = linkBulge(anchor.x, bound.x, LINK_MAX_EXIT_BULGE)
  const kIn = linkBulge(anchor.x, bound.x)
  return (
    `M ${px(anchor.x)},${px(anchor.y)}` +
    ` C ${px(anchor.x + outDir * kOut)},${px(anchor.y)}` +
    ` ${px(bound.x - inDir * kIn)},${px(bound.y)}` +
    ` ${px(bound.x)},${px(bound.y)}`
  )
}

/** Hockey stick: vertical exit from the anchor, horizontal entry into the bound. */
function hockeyPath(anchor: Point, bound: Point, inDir: number): string {
  const kIn = linkBulge(anchor.x, bound.x)
  const pull = { x: anchor.x, y: anchor.y + HOCKEY_PULL * (bound.y - anchor.y) }
  const entry = { x: bound.x - inDir * kIn, y: bound.y }
  return (
    `M ${px(anchor.x)},${px(anchor.y)}` +
    ` C ${px(pull.x)},${px(pull.y)} ${px(entry.x)},${px(entry.y)} ${px(bound.x)},${px(bound.y)}`
  )
}

/** Metro: a 45° diagonal onto the channel, then the bound row, corners rounded. */
function metroPath(anchor: Point, outDir: number, bound: Point, inDir: number): string {
  const yC = (anchor.y + bound.y) / 2
  const yHalf = yC - anchor.y
  const sy = yHalf >= 0 ? 1 : -1
  const x1 = anchor.x + outDir * ELBOW_STUB
  let x2 = bound.x - inDir * ELBOW_APPROACH
  if (Math.abs(x2 - x1) < ELBOW_MIN_RUN) x2 = x1
  // The diagonal runs towards the bound; when the room is too tight it is cut
  // short and the rest of the drop is vertical.
  const sx = x2 - x1 >= 0 ? 1 : -1
  const diag = Math.abs(yHalf)
  const avail = (x2 - x1) * sx
  const points: Point[] = [anchor, { x: x1, y: anchor.y }]
  if (avail >= diag) {
    points.push({ x: x1 + sx * diag, y: yC })
  } else {
    const cut = Math.max(0, avail)
    points.push({ x: x1 + sx * cut, y: anchor.y + sy * cut }, { x: x1 + sx * cut, y: yC })
  }
  points.push({ x: x2, y: yC }, { x: x2, y: bound.y }, bound)
  return roundedPath(points, METRO_CORNER)
}

/** Path of one link in the requested style. */
function stylePath(
  style: LinkStyle,
  anchor: Point,
  outDir: number,
  bound: Point,
  inDir: number,
): string {
  switch (style) {
    case 'sharp':
      return elbowPath(anchor, outDir, bound, inDir, 0)
    case 'smooth':
      return elbowPath(anchor, outDir, bound, inDir, SMOOTH_CORNER)
    case 's-curve':
      return sCurvePath(anchor, outDir, bound, inDir)
    case 'hockey':
      return hockeyPath(anchor, bound, inDir)
    case 'metro':
      return metroPath(anchor, outDir, bound, inDir)
    default:
      return elbowPath(anchor, outDir, bound, inDir, ELBOW_CORNER)
  }
}

/**
 * Connector of one link in the requested style: horizontal approach into the
 * bound edge in every style (so the tick stays perpendicular to the line and
 * marks the constrained date).
 */
export function linkArrow(e: LinkEndpoints, style: LinkStyle = LINK_STYLE_DEFAULT): LinkArrow {
  const fromStart = anchorIsStart(e.type)
  const toStart = boundIsStart(e.type)

  const boundX = toStart ? e.succStartX : e.succEndX
  // A left edge is left outwards, a right edge rightwards; a start edge is
  // entered from the left, an end edge from the right.
  const outDir = fromStart ? -1 : 1
  const inDir = toStart ? 1 : -1

  const anchor: Point = { x: fromStart ? e.predStartX : e.predEndX, y: e.predY }
  const bound: Point = { x: boundX, y: e.succY }
  const d = stylePath(style, anchor, outDir, bound, inDir)

  const tipX = px(boundX)
  const boundY = px(e.succY)

  return {
    d,
    tick: `M ${tipX},${px(boundY - LINK_TICK_HALF)} L ${tipX},${px(boundY + LINK_TICK_HALF)}`,
    tipX,
    tipY: boundY,
  }
}
