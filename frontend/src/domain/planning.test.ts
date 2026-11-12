import { describe, expect, it } from 'vitest'
import { addResourceAssignment, findPlanningTask, findTaskProcess, projectPriorityChanges, removeResourceAssignment, reorderItems, taskDateRollback } from './planning'
import { assignmentAllowed } from './resourceUsage'
import { temporaryIdFromEntropy } from './temporaryId'
import { persistenceOrder, resolveTaskMove } from './dependencies'

describe('planning projections', () => {
  it('finds top-level tasks and subtasks without changing their process', () => {
    const task = { id: 7, subtasks: [{ id: 8 }] }
    const processes = [{ id: 1, tasks: [] }, { id: 2, tasks: [task] }]
    expect(findPlanningTask(processes, 7)).toBe(task)
    expect(findPlanningTask(processes, 8)).toBe(task.subtasks[0])
    expect(findTaskProcess(processes, 8)).toBe(processes[1])
    expect(findPlanningTask(processes, 99)).toBeUndefined()
    expect(findTaskProcess(processes, 99)).toBeUndefined()
  })

  it.each([[0, 2, [2, 3, 1]], [2, 0, [3, 1, 2]], [1, 1, [1, 2, 3]]])('reorders %s to %s without modifying the source', (from, to, ids) => {
    const original = Object.freeze([{ id: 1 }, { id: 2 }, { id: 3 }])
    const source = [...original]
    expect(reorderItems(source, from as number, to as number)?.map((p) => p.id)).toEqual(ids)
    expect(source).toEqual(original)
  })

  it.each([[-1, 1], [0, -1], [3, 1], [0, 3]])('rejects out-of-range reorder %s to %s without changing the list', (from, to) => {
    const list = [1, 2, 3]
    expect(reorderItems(list, from, to)).toBeNull()
    expect(list).toEqual([1, 2, 3])
  })

  it('emits only changed project priorities including temporary identities', () => {
    const projects = [{ id: 1, priority: 1 }, { id: -1000001, priority: 3 }, { id: 2, priority: 2 }]
    expect(projectPriorityChanges(projects)).toEqual([{ id: -1000001, priority: 2 }, { id: 2, priority: 3 }])
    expect(projects[1]!.priority).toBe(3)
  })

  it('deduplicates assignment replay and removes only the selected assignment', () => {
    const original = [{ id: 1, assignment_id: -10, quantity: 2, code: 'R1' }]
    const next = addResourceAssignment(original, { id: 2, assignment_id: -11, quantity: 3, code: 'R2' })
    expect(original).toHaveLength(1)
    expect(addResourceAssignment(next, { id: 1, assignment_id: -12, quantity: 99, code: 'Changed' })).toBe(next)
    expect(removeResourceAssignment(next, -10, 'assignment')).toEqual([next[1]])
    expect(removeResourceAssignment(next, 2, 'resource')).toEqual(original)
    expect(next).toHaveLength(2)
  })

  it('keeps the accepted cascade prefix and a newer proposal when restoring an unaccepted suffix', () => {
    const tasks = [{ id: 1, start_date: '2026-11-01', end_date: '2026-11-03' }, { id: 2, start_date: '2026-11-03', end_date: '2026-11-05' }]
    const edges = [{ id: 1, task_id: 2, depends_on_task_id: 1, type: 'fs' as const }]
    const before = structuredClone(tasks)
    const patches = resolveTaskMove(tasks, edges, 1, '2026-11-08', '2026-11-10')
    expect(persistenceOrder([...patches.keys()], edges)).toEqual([1, 2])
    expect(tasks).toEqual(before)
    const first = { ...tasks[0], ...patches.get(1) }
    const second = { ...tasks[1], ...patches.get(2) }
    expect(taskDateRollback(second, patches.get(2)!, tasks[1]!)).toEqual(tasks[1])
    expect(first.start_date).toBe('2026-11-08')
    expect(taskDateRollback({ ...second, end_date: '2026-12-01' }, patches.get(2)!, tasks[1]!)).toBeNull()
  })
})

describe('assignment owner invariants', () => {
  it.each([true, false])('rejects mismatched owners even when all=%s', (all) => {
    expect(assignmentAllowed({ processOwner: 1, resourceOwner: 2, taskOwner: 2, userId: 2, all })).toBe(false)
  })
  it('allows broad scope only when known process/resource owners agree', () => {
    expect(assignmentAllowed({ processOwner: 2, resourceOwner: 2, taskOwner: 3, userId: 1, all: true })).toBe(true)
  })
  it.each([1, 2, undefined])('narrow scope preserves the task owner check (%s)', (taskOwner) => {
    expect(assignmentAllowed({ processOwner: 1, resourceOwner: 1, taskOwner, userId: 1, all: false })).toBe(taskOwner === 1)
  })
  it('keeps cold-cache validation authoritative on the backend', () => {
    expect(assignmentAllowed({ all: false })).toBe(true)
    expect(assignmentAllowed({ resourceOwner: 2, userId: 1, all: false })).toBe(false)
  })
})

describe('temporary identities from explicit entropy', () => {
  it.each([[0, 0], [0xffffffff, 0xffffffff], [0x80000000, 0x80000000]])('produces stable negative safe ids for %s/%s', (high, low) => {
    const id = temporaryIdFromEntropy(high, low)
    expect(Number.isSafeInteger(id)).toBe(true)
    expect(id).toBeLessThanOrEqual(-1000000)
    expect(temporaryIdFromEntropy(high, low)).toBe(id)
  })
  it('does not depend on a shared wall clock', () => {
    expect(new Set(Array.from({ length: 1000 }, (_, i) => temporaryIdFromEntropy(0, i))).size).toBe(1000)
  })
})
