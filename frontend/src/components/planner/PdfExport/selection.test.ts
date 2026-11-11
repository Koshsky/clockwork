import { describe, expect, it } from 'vitest'
import { pageSlices } from './selection'

describe('print page row boundaries', () => {
  it('keeps rows intact and covers all selected content', () => {
    expect(pageSlices(230, 100, [0, 26, 52, 78, 104, 130, 156, 182, 208])).toEqual([
      { from: 0, to: 78 }, { from: 78, to: 156 }, { from: 156, to: 230 },
    ])
  })
  it('moves a group to the next page when the complete group fits there', () => {
    expect(pageSlices(240, 100, [0, 26, 52, 78, 104, 130, 156, 182, 208], [{ from: 0, to: 78 }, { from: 78, to: 156 }, { from: 156, to: 240 }])).toEqual([
      { from: 0, to: 78 }, { from: 78, to: 156 }, { from: 156, to: 240 },
    ])
  })
  it('uses a single page for a short or empty selection', () => {
    expect(pageSlices(50, 100, [])).toEqual([{ from: 0, to: 50 }])
    expect(pageSlices(0, 100, [])).toEqual([{ from: 0, to: 0 }])
  })
  it('handles oversized rows without getting stuck', () => {
    expect(pageSlices(250, 100, [0, 250])).toEqual([{ from: 0, to: 100 }, { from: 100, to: 200 }, { from: 200, to: 250 }])
  })
  it('rejects invalid or unbounded pagination', () => {
    expect(() => pageSlices(100, 0, [])).toThrow()
    expect(() => pageSlices(1000, 1, [])).toThrow()
  })
})
