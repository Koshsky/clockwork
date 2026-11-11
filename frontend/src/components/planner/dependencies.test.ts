/**
 * Matrix tests for the task dependency engine (src/components/planner/dependencies.ts).
 *
 * Covers the full 16-case behavior table: 4 link types × {pred drag, succ
 * drag} × {left, right}. Conventions:
 *   - dragging the PREDECESSOR right pushes the SUCCESSOR right so the bound
 *     holds exactly (fs: successor start == predecessor end);
 *   - dragging the SUCCESSOR left clamps it to the bound (snap back);
 *   - the other two directions are free (never pulled left, never pushed when
 *     the bound already holds).
 * Plus: chain propagation (A→B→C), clamping of the dragged task itself by its
 * own predecessors, and add-link auto-adjustment of the successor's dates.
 */
import { describe, expect, it } from 'vitest'
import {
  resolveTaskMove,
  resolveAddDependency,
  anchorDate,
  boundDate,
  type DependencyEdge,
  type DependencyType,
  type TaskDates,
} from './dependencies'

const T1: TaskDates = { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' }
const T2: TaskDates = { id: 2, start_date: '2026-01-15', end_date: '2026-01-20' }

function edge(pred: number, succ: number, type: DependencyType): DependencyEdge {
  return { id: pred * 100 + succ, task_id: succ, depends_on_task_id: pred, type }
}

/** Patch lookup helper. */
function patchOf(m: Map<number, { start_date: string; end_date: string }>, id: number) {
  return m.get(id)
}

describe('bound/anchor semantics', () => {
  it('bounds the successor start for fs/ss and end for ff/sf', () => {
    expect(boundDate('fs', T1)).toBe('2026-01-01')
    expect(boundDate('ss', T1)).toBe('2026-01-01')
    expect(boundDate('ff', T1)).toBe('2026-01-10')
    expect(boundDate('sf', T1)).toBe('2026-01-10')
  })
  it('anchors the predecessor end for fs/ff and start for ss/sf', () => {
    expect(anchorDate('fs', T1)).toBe('2026-01-10')
    expect(anchorDate('ff', T1)).toBe('2026-01-10')
    expect(anchorDate('ss', T1)).toBe('2026-01-01')
    expect(anchorDate('sf', T1)).toBe('2026-01-01')
  })
})

describe('16-case drag matrix', () => {
  const cases: Array<{
    name: string
    type: DependencyType
    movedId: number
    newStart: string
    newEnd: string
    expectSuccShifted: boolean
    expectSuccStart?: string
    expectSuccEnd?: string
  }> = [
    // -- fs: successor must start after predecessor ends --
    { name: 'fs pred right → succ pushed (сук end == pred end)', type: 'fs', movedId: 1, newStart: '2026-01-11', newEnd: '2026-01-20', expectSuccShifted: true, expectSuccStart: '2026-01-20', expectSuccEnd: '2026-01-25' },
    { name: 'fs pred right (bound still holds) → free', type: 'fs', movedId: 1, newStart: '2026-01-05', newEnd: '2026-01-14', expectSuccShifted: false },
    { name: 'fs pred left → free', type: 'fs', movedId: 1, newStart: '2025-12-20', newEnd: '2025-12-29', expectSuccShifted: false },
    { name: 'fs succ right → free', type: 'fs', movedId: 2, newStart: '2026-02-01', newEnd: '2026-02-06', expectSuccShifted: false },
    { name: 'fs succ left → clamped to pred end', type: 'fs', movedId: 2, newStart: '2026-01-05', newEnd: '2026-01-10', expectSuccShifted: true, expectSuccStart: '2026-01-10', expectSuccEnd: '2026-01-15' },
    // -- ss: successor must start after predecessor starts --
    { name: 'ss pred right → succ pushed (succ start == pred start)', type: 'ss', movedId: 1, newStart: '2026-01-20', newEnd: '2026-01-29', expectSuccShifted: true, expectSuccStart: '2026-01-20', expectSuccEnd: '2026-01-25' },
    { name: 'ss succ left → clamped to pred start', type: 'ss', movedId: 2, newStart: '2025-12-20', newEnd: '2025-12-25', expectSuccShifted: true, expectSuccStart: '2026-01-01', expectSuccEnd: '2026-01-06' },
    // -- ff: successor must end after predecessor ends --
    { name: 'ff pred right → succ pushed (succ end == pred end)', type: 'ff', movedId: 1, newStart: '2026-01-11', newEnd: '2026-02-01', expectSuccShifted: true, expectSuccStart: '2026-01-27', expectSuccEnd: '2026-02-01' },
    { name: 'ff succ left → clamped to pred end', type: 'ff', movedId: 2, newStart: '2026-01-01', newEnd: '2026-01-05', expectSuccShifted: true, expectSuccStart: '2026-01-06', expectSuccEnd: '2026-01-10' },
    // -- sf: successor must end after predecessor starts --
    { name: 'sf pred right → succ pushed (succ end == pred start)', type: 'sf', movedId: 1, newStart: '2026-01-21', newEnd: '2026-01-30', expectSuccShifted: true, expectSuccStart: '2026-01-16', expectSuccEnd: '2026-01-21' },
    { name: 'sf succ left → clamped to pred start', type: 'sf', movedId: 2, newStart: '2025-12-20', newEnd: '2025-12-25', expectSuccShifted: true, expectSuccStart: '2025-12-27', expectSuccEnd: '2026-01-01' },
  ]

  for (const tc of cases) {
    it(tc.name, () => {
      const base: Array<TaskDates> = [
        { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' },
        { id: 2, start_date: '2026-01-15', end_date: '2026-01-20' },
      ]
      const edges = [edge(1, 2, tc.type)]
      const result = resolveTaskMove(base, edges, tc.movedId, tc.newStart, tc.newEnd)
      if (!tc.expectSuccShifted) {
        // The dependency imposed no extra shifts: only the moved task changed
        // (to exactly what was requested — the drag is never pulled back).
        expect(result.size).toBe(1)
        expect(result.get(tc.movedId)).toEqual({ start_date: tc.newStart, end_date: tc.newEnd })
        return
      }
      const succ = patchOf(result, 2)
      expect(succ).toBeDefined()
      expect(succ!.start_date).toBe(tc.expectSuccStart)
      expect(succ!.end_date).toBe(tc.expectSuccEnd)
    })
  }
})

describe('chain propagation', () => {
  it('pushes B and then C when A moves right (A→B→C, fs)', () => {
    const tasks: TaskDates[] = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' },
      { id: 2, start_date: '2026-01-10', end_date: '2026-01-20' },
      { id: 3, start_date: '2026-01-20', end_date: '2026-01-30' },
    ]
    const edges = [edge(1, 2, 'fs'), edge(2, 3, 'fs')]
    // A extends its end to 01-15 → B must start ≥ 01-15 → C must start ≥ B.end (01-25)
    const result = resolveTaskMove(tasks, edges, 1, '2026-01-01', '2026-01-15')
    expect(patchOf(result, 2)).toEqual({ start_date: '2026-01-15', end_date: '2026-01-25' })
    expect(patchOf(result, 3)).toEqual({ start_date: '2026-01-25', end_date: '2026-02-04' })
  })
})

describe('clamping the dragged task itself', () => {
  it('clamps the dragged successor to its own predecessor bound', () => {
    const tasks: TaskDates[] = [T1, T2]
    const edges = [edge(1, 2, 'fs')]
    // Drag B (id 2) far left: bounds hold only if B.start ≥ A.end (01-10)
    const result = resolveTaskMove(tasks, edges, 2, '2025-12-01', '2025-12-06')
    expect(patchOf(result, 2)).toEqual({ start_date: '2026-01-10', end_date: '2026-01-15' })
  })

  it('keeps the dragged predecessor at its requested position (no pull-back)', () => {
    const tasks: TaskDates[] = [T1, T2]
    const edges = [edge(1, 2, 'fs')]
    const result = resolveTaskMove(tasks, edges, 1, '2025-11-01', '2025-11-10')
    expect(patchOf(result, 1)).toEqual({ start_date: '2025-11-01', end_date: '2025-11-10' })
    expect(patchOf(result, 2)).toBeUndefined()
  })
})

describe('add-link auto-adjustment', () => {
  it('keeps an already-satisfied link unchanged', () => {
    const tasks: TaskDates[] = [T1, T2]
    // fs 1→2: B.start (01-15) ≥ A.end (01-10) holds → no changes
    const result = resolveAddDependency(tasks, [], 2, 1, 'fs')
    expect(result.size).toBe(0)
  })

  it('accepts the bound landing exactly on the anchor (soft >= rule, every type)', () => {
    // The constraints are INCLUSIVE: touching dates are valid, only a strictly
    // earlier bound is a violation. Tightening this to ">" (a minimum one-day
    // lag) is a semantics change, not a fix — see dependencies.ts.
    const pred: TaskDates = { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' }
    const touching: Array<{ type: DependencyType; succ: TaskDates }> = [
      // fs: successor starts on the predecessor's end day
      { type: 'fs', succ: { id: 2, start_date: '2026-01-10', end_date: '2026-01-15' } },
      // ss: both start on the same day
      { type: 'ss', succ: { id: 2, start_date: '2026-01-01', end_date: '2026-01-06' } },
      // ff: both end on the same day
      { type: 'ff', succ: { id: 2, start_date: '2026-01-05', end_date: '2026-01-10' } },
      // sf: successor ends on the predecessor's start day
      { type: 'sf', succ: { id: 2, start_date: '2025-12-28', end_date: '2026-01-01' } },
    ]
    for (const c of touching) {
      expect(resolveAddDependency([pred, c.succ], [], 2, 1, c.type).size, c.type).toBe(0)
    }
  })

  it('pushes a successor that falls one day short up to the touching date', () => {
    const pred: TaskDates = { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' }
    const succ: TaskDates = { id: 2, start_date: '2026-01-09', end_date: '2026-01-14' }
    const result = resolveAddDependency([pred, succ], [], 2, 1, 'fs')
    // Exactly one day: the bound lands ON the anchor, not one day past it.
    expect(patchOf(result, 2)).toEqual({ start_date: '2026-01-10', end_date: '2026-01-15' })
  })

  it('ff link pushes the successor until its end reaches the predecessor end', () => {
    const tasks: TaskDates[] = [T1, T2]
    // B.end (01-20) ≥ A.end (01-10) holds → no change
    expect(resolveAddDependency(tasks, [], 2, 1, 'ff').size).toBe(0)
  })

  it('fs link pushes a violating successor to the predecessor end', () => {
    // Successor starts before the predecessor ends: B(01-05..01-10), A(01-01..01-10)
    const tasks: TaskDates[] = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' },
      { id: 2, start_date: '2026-01-05', end_date: '2026-01-10' },
    ]
    const result = resolveAddDependency(tasks, [], 2, 1, 'fs')
    expect(patchOf(result, 2)).toEqual({ start_date: '2026-01-10', end_date: '2026-01-15' })
  })

  it('chains through the existing graph when adding a link', () => {
    const tasks: TaskDates[] = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' },
      { id: 2, start_date: '2026-01-05', end_date: '2026-01-10' },
      { id: 3, start_date: '2026-01-10', end_date: '2026-01-20' },
    ]
    // Existing 2→3 fs; adding 1→2 fs pushes B (01-10) and then C (01-20)
    const edges = [edge(2, 3, 'fs')]
    const result = resolveAddDependency(tasks, edges, 2, 1, 'fs')
    expect(patchOf(result, 2)).toEqual({ start_date: '2026-01-10', end_date: '2026-01-15' })
    expect(patchOf(result, 3)).toEqual({ start_date: '2026-01-15', end_date: '2026-01-25' })
  })
})

describe('duration preservation', () => {
  it('keeps every shifted task duration intact', () => {
    const tasks: TaskDates[] = [
      { id: 1, start_date: '2026-01-01', end_date: '2026-01-10' },
      { id: 2, start_date: '2026-01-10', end_date: '2026-01-20' },
    ]
    const result = resolveTaskMove(tasks, [edge(1, 2, 'fs')], 1, '2026-01-01', '2026-01-15')
    const succ = patchOf(result, 2)!
    const days = (s: string, e: string) =>
      Math.round((new Date(e).getTime() - new Date(s).getTime()) / 86400000)
    expect(days(succ.start_date, succ.end_date)).toBe(days('2026-01-10', '2026-01-20'))
  })
})