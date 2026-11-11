/**
 * Geometry of the dependency connectors: endpoint choice per type, both styles
 * (rounded elbow / s-curve), the terminus tick, the degenerate layouts the
 * planner produces (bars touching, backwards links, huge spans) and the
 * invariant that a style switch never moves the endpoints or the tick.
 */
import { describe, expect, it } from 'vitest'
import {
  ELBOW_MIN_RUN,
  LINK_MAX_BULGE,
  LINK_MAX_EXIT_BULGE,
  LINK_MIN_BULGE,
  LINK_TICK_HALF,
  linkArrow,
  linkBulge,
  type LinkEndpoints,
} from './dependencyPaths'
import { LINK_STYLES, LINK_STYLE_DEFAULT, type LinkStyle } from './linkStyle'
import { DEPENDENCY_TYPES, anchorIsStart, boundIsStart, type DependencyType } from './dependencies'

/** All four edges differ, so the type decides which pair is used. */
const ENDPOINTS = {
  predStartX: 100,
  predEndX: 200,
  succStartX: 300,
  succEndX: 400,
  predY: 33,
  succY: 59,
}

function link(type: DependencyType, patch: Partial<LinkEndpoints> = {}): LinkEndpoints {
  return { type, ...ENDPOINTS, ...patch }
}

/** Numbers of a path `d` in source order. */
function nums(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

/** First/last point of a path. */
function firstPoint(d: string): number[] {
  return nums(d).slice(0, 2)
}

function lastPoint(d: string): number[] {
  return nums(d).slice(-2)
}

/** How many times a path command appears. */
function commands(d: string, cmd: 'L' | 'Q' | 'C'): number {
  return (d.match(new RegExp(`\\b${cmd}\\b`, 'g')) ?? []).length
}

describe('linkBulge', () => {
  it('grows with the span but stays inside the bounds', () => {
    expect(linkBulge(0, 0)).toBe(LINK_MIN_BULGE)
    expect(linkBulge(0, 100)).toBe(50)
    expect(linkBulge(0, 1000)).toBe(LINK_MAX_BULGE)
    expect(linkBulge(1000, 0)).toBe(LINK_MAX_BULGE)
  })

  it('keeps the exit hook shorter than the entry hook', () => {
    expect(linkBulge(0, 1000, LINK_MAX_EXIT_BULGE)).toBe(LINK_MAX_EXIT_BULGE)
    expect(LINK_MAX_EXIT_BULGE).toBeLessThan(LINK_MAX_BULGE)
  })
})

describe('default style', () => {
  it('is the rounded elbow (see linkStyle.test.ts for the setting itself)', () => {
    expect(LINK_STYLE_DEFAULT).toBe('rounded')
    expect(commands(linkArrow(link('fs')).d, 'Q')).toBeGreaterThan(0)
  })
})

describe('rounded elbow — route per dependency type', () => {
  it('fs: predecessor END → successor START', () => {
    const a = linkArrow(link('fs'), 'rounded')
    expect(a.d).toBe(
      'M 200,33 L 204,33 Q 208,33 208,37 L 208,41 Q 208,46 213,46 L 281,46 Q 286,46 286,51 L 286,54 Q 286,59 291,59 L 300,59',
    )
    expect(a.tipX).toBe(300)
    expect(a.tipY).toBe(59)
  })

  it('ff: predecessor END → successor END (route closes in from the right)', () => {
    expect(linkArrow(link('ff'), 'rounded').d).toBe(
      'M 200,33 L 204,33 Q 208,33 208,37 L 208,41 Q 208,46 213,46 L 409,46 Q 414,46 414,51 L 414,54 Q 414,59 409,59 L 400,59',
    )
  })

  it('ss: predecessor START → successor START (route opens to the left)', () => {
    expect(linkArrow(link('ss'), 'rounded').d).toBe(
      'M 100,33 L 96,33 Q 92,33 92,37 L 92,41 Q 92,46 97,46 L 281,46 Q 286,46 286,51 L 286,54 Q 286,59 291,59 L 300,59',
    )
  })

  it('sf: predecessor START → successor END', () => {
    expect(linkArrow(link('sf'), 'rounded').d).toBe(
      'M 100,33 L 96,33 Q 92,33 92,37 L 92,41 Q 92,46 97,46 L 409,46 Q 414,46 414,51 L 414,54 Q 414,59 409,59 L 400,59',
    )
  })

  it('uses exactly the edge pair the engine helpers describe', () => {
    for (const type of DEPENDENCY_TYPES) {
      const a = linkArrow(link(type), 'rounded')
      const [anchorX] = firstPoint(a.d)
      expect(anchorX, type).toBe(anchorIsStart(type) ? ENDPOINTS.predStartX : ENDPOINTS.predEndX)
      expect(a.tipX, type).toBe(boundIsStart(type) ? ENDPOINTS.succStartX : ENDPOINTS.succEndX)
    }
  })
})

describe('rounded elbow — degenerate layouts', () => {
  it('bars touching: the two verticals merge into a staircase', () => {
    const a = linkArrow(link('fs', { predEndX: 200, succStartX: 200 }), 'rounded')
    expect(a.d).toBe(
      'M 200,33 L 204,33 Q 208,33 208,37 L 208,41 Q 208,46 208,51 L 208,55 Q 208,59 204,59 L 200,59',
    )
    // The route never swings back over the predecessor's own bar.
    const xs = a.d.match(/-?\d+(?:\.\d+)?/g)?.map(Number).filter((_, i) => i % 2 === 0) ?? []
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(200)
  })

  it('a gap smaller than the threshold still merges', () => {
    const gap = ELBOW_MIN_RUN - 1
    const a = linkArrow(link('fs', { predEndX: 200, succStartX: 200 + gap }), 'rounded')
    expect(commands(a.d, 'Q')).toBe(3)
  })

  it('a backwards link (successor starts before the predecessor) stays finite', () => {
    const a = linkArrow(
      link('ss', { predStartX: 500, predEndX: 600, succStartX: 100, succEndX: 200 }),
      'rounded',
    )
    expect(a.d).toBe(
      'M 500,33 L 496,33 Q 492,33 492,37 L 492,41 Q 492,46 487,46 L 91,46 Q 86,46 86,51 L 86,54 Q 86,59 91,59 L 100,59',
    )
  })

  it('rounds every corner and keeps the radius inside the adjacent segments', () => {
    // 4 corners on a full route, each corner preceded by a straight run.
    expect(commands(linkArrow(link('fs'), 'rounded').d, 'Q')).toBe(4)
    const d = linkArrow(link('fs'), 'rounded').d
    expect(d).not.toMatch(/NaN|Infinity|undefined/)
    // No curve commands in an orthogonal route.
    expect(commands(d, 'C')).toBe(0)
  })
})

describe('orthogonal variants — sharp, smooth, metro', () => {
  it('sharp: the rounded route with square corners', () => {
    const a = linkArrow(link('fs'), 'sharp')
    expect(a.d).toBe('M 200,33 L 208,33 L 208,46 L 286,46 L 286,59 L 300,59')
    expect(commands(a.d, 'Q')).toBe(0)
    expect(a.tipX).toBe(300)
    expect(a.tipY).toBe(59)
  })

  it('smooth: the same route with large corners, zero-length steps dropped', () => {
    const a = linkArrow(link('fs'), 'smooth')
    expect(a.d).toBe(
      'M 200,33 L 204,33 Q 208,33 208,37 L 208,39.5 Q 208,46 214.5,46 L 279.5,46 Q 286,46 286,52.5 Q 286,59 292.5,59 L 300,59',
    )
    expect(commands(a.d, 'Q')).toBe(4)
  })

  it('metro: a 45° diagonal onto the channel, corners rounded', () => {
    const a = linkArrow(link('fs'), 'metro')
    expect(a.d).toBe(
      'M 200,33 L 204,33 Q 208,33 210.83,35.83 L 216.76,41.76 Q 221,46 227,46 L 280,46 Q 286,46 286,52 L 286,53 Q 286,59 292,59 L 300,59',
    )
    // The diagonal runs at exactly 45°: a point sits as far right of the exit
    // stub (x = 208) as it sits below the anchor row (y = 33).
    const flat = nums(a.d)
    const pairs: Array<[number, number]> = []
    for (let i = 0; i + 1 < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]])
    expect(pairs.some(([x, y]) => x > 208 && Math.abs(x - 208 - (y - 33)) < 0.01)).toBe(true)
  })

  it('every orthogonal style keeps the route inside the predecessor edge', () => {
    for (const style of ['sharp', 'rounded', 'smooth', 'metro'] as LinkStyle[]) {
      const a = linkArrow(link('fs', { predEndX: 200, succStartX: 200 }), style)
      const xs = (a.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number).filter((_, i) => i % 2 === 0)
      expect(Math.min(...xs), style).toBeGreaterThanOrEqual(200)
      expect(commands(a.d, 'C'), style).toBe(0)
    }
  })
})

describe('curve variants — hockey', () => {
  it('leaves the anchor vertically and enters the bound edge horizontally', () => {
    const a = linkArrow(link('fs'), 'hockey')
    expect(a.d).toBe('M 200,33 C 200,47.3 250,59 300,59')
    expect(commands(a.d, 'C')).toBe(1)
    expect(commands(a.d, 'Q')).toBe(0)
    // Vertical exit: the first control point shares the anchor's x.
    expect(nums(a.d)[2]).toBe(200)
    // Horizontal entry: the second control point shares the bound's y.
    expect(nums(a.d)[5]).toBe(59)
  })

  it('mirrors upward when the successor row is above', () => {
    const a = linkArrow(link('ss', { predStartX: 100, predEndX: 200, succStartX: 300, succEndX: 400, succY: 33, predY: 59 }), 'hockey')
    const n = nums(a.d)
    expect(n[1]).toBe(59)
    expect(n[3]).toBeLessThan(59)
    expect(n[n.length - 1]).toBe(33)
  })
})

describe('s-curve — route per dependency type', () => {
  it('fs: predecessor END → successor START', () => {
    const a = linkArrow(link('fs'), 's-curve')
    expect(a.d).toBe('M 200,33 C 248,33 250,59 300,59')
    expect(a.tipX).toBe(300)
    expect(a.tipY).toBe(59)
    expect(commands(a.d, 'C')).toBe(1)
    expect(commands(a.d, 'Q')).toBe(0)
  })

  it('ff: predecessor END → successor END (curve closes from the right)', () => {
    expect(linkArrow(link('ff'), 's-curve').d).toBe('M 200,33 C 248,33 500,59 400,59')
  })

  it('ss: predecessor START → successor START (curve opens to the left)', () => {
    expect(linkArrow(link('ss'), 's-curve').d).toBe('M 100,33 C 52,33 200,59 300,59')
  })

  it('sf: predecessor START → successor END, entry hook clamped on a wide span', () => {
    expect(linkBulge(100, 400)).toBe(LINK_MAX_BULGE)
    expect(linkArrow(link('sf'), 's-curve').d).toBe('M 100,33 C 52,33 520,59 400,59')
  })

  it('caps the exit hook so a long link cannot reach back over the task labels', () => {
    const a = linkArrow(link('sf', { succEndX: 9000 }), 's-curve')
    const [anchorX, , c1x] = nums(a.d)
    expect(anchorX).toBe(100)
    expect(anchorX - c1x).toBe(LINK_MAX_EXIT_BULGE)
  })
})

describe('linkArrow — terminus tick', () => {
  for (const style of LINK_STYLES) {
    it(`is vertical, centered on the successor row and on the bound edge (${style})`, () => {
      for (const type of DEPENDENCY_TYPES) {
        const a = linkArrow(link(type), style)
        const [x1, y1, x2, y2] = nums(a.tick)
        expect(x1, type).toBe(a.tipX)
        expect(x2, type).toBe(a.tipX)
        expect(y1, type).toBe(a.tipY - LINK_TICK_HALF)
        expect(y2, type).toBe(a.tipY + LINK_TICK_HALF)
      }
    })
  }
})

describe('style invariant', () => {
  const layouts: Array<Partial<LinkEndpoints>> = [
    {},
    { predEndX: 200, succStartX: 200 },
    { succStartX: 100, succEndX: 120 },
    { predStartX: 0, predEndX: 5000, succStartX: 6000, succEndX: 9000 },
    { predY: 33, succY: 33 },
  ]

  it('switching the style keeps the endpoints and the tick identical', () => {
    for (const type of DEPENDENCY_TYPES) {
      for (const patch of layouts) {
        const reference = linkArrow(link(type, patch), LINK_STYLES[0])
        for (const style of LINK_STYLES) {
          const arrow = linkArrow(link(type, patch), style)
          const where = `${style} ${type} ${JSON.stringify(patch)}`
          expect(firstPoint(arrow.d), where).toEqual(firstPoint(reference.d))
          expect(lastPoint(arrow.d), where).toEqual(lastPoint(reference.d))
          expect(arrow.tick, where).toBe(reference.tick)
          expect(arrow.tipX, where).toBe(reference.tipX)
          expect(arrow.tipY, where).toBe(reference.tipY)
        }
      }
    }
  })

  it('splits into polyline styles and single-cubic styles', () => {
    const curves: LinkStyle[] = ['s-curve', 'hockey']
    for (const style of LINK_STYLES) {
      const d = linkArrow(link('fs'), style).d
      if (curves.includes(style)) {
        expect(commands(d, 'C'), style).toBe(1)
        expect(commands(d, 'Q'), style).toBe(0)
      } else {
        expect(commands(d, 'C'), style).toBe(0)
      }
    }
  })

  it('produces well-formed path data for every type, layout and style', () => {
    for (const style of LINK_STYLES) {
      for (const type of DEPENDENCY_TYPES) {
        for (const patch of layouts) {
          const a = linkArrow(link(type, patch), style)
          const where = `${style} ${type} ${JSON.stringify(patch)}`
          expect(a.d, where).not.toMatch(/NaN|Infinity|undefined/)
          expect(nums(a.d).every(Number.isFinite), where).toBe(true)
          expect(nums(a.tick), where).toHaveLength(4)
        }
      }
    }
  })

  it('s-curve spans exactly 8 numbers (one cubic)', () => {
    for (const type of DEPENDENCY_TYPES) {
      expect(nums(linkArrow(link(type), 's-curve').d), type).toHaveLength(8)
    }
  })
})
