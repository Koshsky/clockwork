/**
 * Scheduling dependency engine between tasks (fs/ss/ff/sf).
 *
 * Pure logic (no store / API imports) — mirrors the backend constraint
 * semantics 1:1:
 *   - one link P → S (predecessor → successor) bounds a date of S by an
 *     anchor date of P:
 *       fs — S must NOT start before P ends    (bound = S.start, anchor = P.end)
 *       ss — S must NOT start before P starts  (bound = S.start, anchor = P.start)
 *       ff — S must NOT end   before P ends    (bound = S.end,   anchor = P.end)
 *       sf — S must NOT end   before P starts  (bound = S.end,   anchor = P.start)
 *   - the rules are INCLUSIVE (`>=`): a bound that lands exactly on the anchor
 *     date is valid, there is no minimum one-day lag — only a strictly earlier
 *     bound is a violation and gets shifted right;
 *   - a move of one task re-resolves the subgraph to a fixpoint, shifting
 *     successors right when a bound is violated and clamping a task that is
 *     dragged before its own predecessor bound (see the 16-case matrix in
 *     dependencies.test.ts). Tasks are never pulled left by a dependency.
 *
 * Dates are ISO "YYYY-MM-DD" strings (backend DATE type) — plain string
 * comparison is correct for equal-length ISO dates.
 */
import { addDaysISO, toDate } from './calendar'
import { DAY_MS } from '@/utils'
import { t } from '@/i18n'

export type DependencyType = 'fs' | 'ss' | 'ff' | 'sf'

export const DEPENDENCY_TYPES: readonly DependencyType[] = ['fs', 'ss', 'ff', 'sf']

/**
 * Localized label of a link type. Built per call instead of a module-level map,
 * so a language switch re-renders the selects and option lists that use it.
 */
export function dependencyLabel(type: DependencyType): string {
  return t(`planner.dependencies.${type}`)
}

/** Labels of every link type, in `DEPENDENCY_TYPES` order (call-time, reactive). */
export function dependencyLabels(): Record<DependencyType, string> {
  return {
    fs: dependencyLabel('fs'),
    ss: dependencyLabel('ss'),
    ff: dependencyLabel('ff'),
    sf: dependencyLabel('sf'),
  }
}

/** One scheduling link as stored in the planning aggregate / API. */
export interface DependencyEdge {
  id: number
  /** Successor: the task that depends on the predecessor. */
  task_id: number
  /** Predecessor: the task the successor depends on. */
  depends_on_task_id: number
  type: DependencyType
}

/** The dates of one task (top-level rows of a process). */
export interface TaskDates {
  id: number
  start_date: string
  end_date: string
}

/** A concrete date patch (duration preserved by shifts). */
export interface TaskDatePatch {
  start_date: string
  end_date: string
}

/** Whether the link bounds the successor's START date (fs/ss). */
export function boundIsStart(type: DependencyType): boolean {
  return type === 'fs' || type === 'ss'
}

/** Whether the link anchors the predecessor's START date (ss/sf). */
export function anchorIsStart(type: DependencyType): boolean {
  return type === 'ss' || type === 'sf'
}

/** The successor date the link constrains. */
export function boundDate(type: DependencyType, task: TaskDatePatch): string {
  return boundIsStart(type) ? task.start_date : task.end_date
}

/** The predecessor date that anchors the link. */
export function anchorDate(type: DependencyType, pred: TaskDatePatch): string {
  return anchorIsStart(type) ? pred.start_date : pred.end_date
}

/** Whole-day difference (b − a) in calendar days. */
function dayDiff(a: string, b: string): number {
  return Math.round((toDate(b).getTime() - toDate(a).getTime()) / DAY_MS)
}

/** Shifts both dates by whole calendar days (duration preserved). */
function shiftDays(dates: TaskDatePatch, deltaDays: number): TaskDatePatch {
  return {
    start_date: addDaysISO(dates.start_date, deltaDays),
    end_date: addDaysISO(dates.end_date, deltaDays),
  }
}

/** Resolves every violated bound to a fixpoint: successors shift right by the
 *  exact violation; a dragged task past its own bound is clamped to it.
 *  Returns a Map of task id → final dates; tasks with unchanged dates are
 *  excluded (the caller decides what to keep). */
export function resolveTaskMove(
  tasks: TaskDates[],
  edges: DependencyEdge[],
  movedId: number,
  newStart: string,
  newEnd: string,
): Map<number, TaskDatePatch> {
  const current = new Map<number, TaskDatePatch>()
  for (const t of tasks) current.set(t.id, { start_date: t.start_date, end_date: t.end_date })
  current.set(movedId, { start_date: newStart, end_date: newEnd })
  return diff(current, tasks, edges)
}

/** Resolves violations of an additional edge against the CURRENT schedule
 *  (used when a link is about to be added): the successor shifts right as
 *  needed (with chains). Returns the date patches to persist. */
export function resolveAddDependency(
  tasks: TaskDates[],
  edges: DependencyEdge[],
  taskId: number,
  predecessorId: number,
  type: DependencyType,
): Map<number, TaskDatePatch> {
  return resolveEdges(tasks, [...edges, { id: -1, task_id: taskId, depends_on_task_id: predecessorId, type }])
}

/** Resolves violations of a modified edge set against the CURRENT schedule
 *  (used when a link type changes): only the successor side is adjusted.
 *  Returns the date patches to persist. */
export function resolveEdges(tasks: TaskDates[], edges: DependencyEdge[]): Map<number, TaskDatePatch> {
  const current = new Map<number, TaskDatePatch>()
  for (const t of tasks) current.set(t.id, { start_date: t.start_date, end_date: t.end_date })
  return diff(current, tasks, edges)
}

/** Runs the fixpoint solver and diffs the result against the original dates. */
function diff(
  current: Map<number, TaskDatePatch>,
  tasks: TaskDates[],
  edges: DependencyEdge[],
): Map<number, TaskDatePatch> {
  resolveFixpoint(current, edges)
  const out = new Map<number, TaskDatePatch>()
  for (const t of tasks) {
    const upd = current.get(t.id)
    if (upd && (upd.start_date !== t.start_date || upd.end_date !== t.end_date)) out.set(t.id, upd)
  }
  return out
}

/** Orders ids for persistence so every task is written AFTER its
 *  predecessors (among the given ids) — the backend guard validates the
 *  successor against the predecessors' committed dates. Tolerates unrelated
 *  subsets and (defensively) cycles. */
export function persistenceOrder(ids: number[], edges: DependencyEdge[]): number[] {
  const inSet = new Set(ids)
  const predOf = new Map<number, Set<number>>()
  for (const id of ids) predOf.set(id, new Set())
  for (const e of edges) {
    if (inSet.has(e.task_id) && inSet.has(e.depends_on_task_id)) {
      predOf.get(e.task_id)!.add(e.depends_on_task_id)
    }
  }
  const placed = new Set<number>()
  const out: number[] = []
  for (let guard = 0; placed.size < ids.length && guard <= ids.length; guard++) {
    for (const id of ids) {
      if (placed.has(id)) continue
      let ready = true
      for (const p of predOf.get(id)!) {
        if (inSet.has(p) && !placed.has(p)) {
          ready = false
          break
        }
      }
      if (ready) {
        placed.add(id)
        out.push(id)
      }
    }
  }
  for (const id of ids) {
    if (!placed.has(id)) {
      placed.add(id)
      out.push(id)
    }
  }
  return out
}

/**
 * Fixpoint solver: iterates the edge set until no bound is violated (dates
 * only move right, so the process terminates; the guard bounds pathological
 * input). Dragged/target tasks are clamped the same way as any successor.
 */
function resolveFixpoint(current: Map<number, TaskDatePatch>, edges: DependencyEdge[]): void {
  const maxIterations = edges.length + current.size + 1
  let changed = true
  for (let guard = 0; changed && guard < maxIterations; guard++) {
    changed = false
    for (const e of edges) {
      const succ = current.get(e.task_id)
      const pred = current.get(e.depends_on_task_id)
      if (!succ || !pred) continue
      const bound = boundDate(e.type, succ)
      const anchor = anchorDate(e.type, pred)
      if (bound < anchor) {
        current.set(e.task_id, shiftDays(succ, dayDiff(bound, anchor)))
        changed = true
      }
    }
  }
}