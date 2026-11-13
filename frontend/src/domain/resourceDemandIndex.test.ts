import { computed, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { toDate } from './calendar'
import { indexedResourceUsage, indexResourceDemand, resourceCellUsage, type ResourceProcess, type TaskPreview } from './resourceUsage'

const idle: TaskPreview = { active: false, taskId: null, startDate: null, endDate: null }

// Keep the original scan independent of the optimized implementation and its preview helper.
function reference(processes: ResourceProcess[], resourceId: number, day: Date, preview: TaskPreview): number {
  let used = 0
  for (const process of processes) for (const task of process.tasks ?? []) {
    if (day.getTime() < toDate(task.start_date).getTime() || day.getTime() > toDate(task.end_date).getTime()) continue
    const assignment = task.resources?.find(row => row.resource_id === resourceId)
    if (assignment) used += assignment.quantity
  }
  if (!preview.active || preview.taskId == null || preview.startDate == null || preview.endDate == null) return used
  let selected
  for (const process of processes) {
    selected = process.tasks?.find(task => task.id === preview.taskId)
    if (selected) break
  }
  const assignment = selected?.resources?.find(row => row.resource_id === resourceId)
  if (!selected || !assignment || assignment.quantity === 0) return used
  const inNew = day.getTime() >= toDate(preview.startDate).getTime() && day.getTime() <= toDate(preview.endDate).getTime()
  const inOld = day.getTime() >= toDate(selected.start_date).getTime() && day.getTime() <= toDate(selected.end_date).getTime()
  return inNew === inOld ? used : inNew ? used + assignment.quantity : used - assignment.quantity
}

function demandSamples() {
  let seed = 1771
  const random = (limit: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % limit }
  // Freeze the original random sequence before execution so cases can run independently.
  return ['UTC', 'Europe/Moscow', 'America/New_York'].flatMap(zone => Array.from({ length: 100 }, (_, sample) => {
    const plans = Array.from({ length: 3 }, (_, process) => ({ tasks: Array.from({ length: 8 }, (_, task) => {
      const start = random(12) - 2
      return { id: process * 8 + task, start, end: start + random(9), resources: Array.from({ length: random(6) }, () => ({ resource_id: random(4) + 1, quantity: (random(11) - 2) / 2 })) }
    }) }))
    return { zone, sample, anchor: ['2026-03-02', '2026-10-26', '2020-12-28'][sample % 3]!, plans, previewTasks: [random(24), random(24)] as const }
  }))
}

describe('indexed resource demand', () => {
  it('preserves first duplicate assignments, all duplicate task rows and the first task used by preview', () => {
    const processes = [{ tasks: [
      { id: 1, start_date: '2026-11-09', end_date: '2026-11-10', resources: [{ resource_id: 1, quantity: 2 }, { resource_id: 1, quantity: 99 }] },
      { id: 1, start_date: '2026-11-09', end_date: '2026-11-10', resources: [{ resource_id: 1, quantity: 3 }, { resource_id: 2, quantity: 8 }] },
    ] }]
    const index = indexResourceDemand(processes), day = toDate('2026-11-09')
    expect(indexedResourceUsage(index, 1, day, idle)).toBe(5)
    const preview = { active: true, taskId: 1, startDate: '2026-11-11', endDate: '2026-11-12' }
    expect(indexedResourceUsage(index, 1, day, preview)).toBe(3)
    expect(indexedResourceUsage(index, 2, day, preview)).toBe(8)
    expect(indexedResourceUsage(index, 1, toDate('2026-11-10'), idle)).toBe(5)
    expect(indexedResourceUsage(index, 1, toDate('2026-11-11'), idle)).toBe(0)
  })

  it('preserves malformed dates, missing fields, invalid identities and unusual quantities without normalizing them', () => {
    const processes: ResourceProcess[] = [{}, { tasks: [
      { id: 1, start_date: '', end_date: 'invalid', resources: [{ resource_id: 1, quantity: -2 }, { resource_id: 2, quantity: 0.5 }] },
      { id: 2, start_date: undefined as unknown as string, end_date: '2026-11-09', resources: [{ resource_id: 1, quantity: 4 }] },
      { id: 3, start_date: '2026-11-11', end_date: '2026-11-09', resources: [{ resource_id: 1, quantity: 9 }] },
      { id: 4, start_date: '2026-11-09', end_date: '2026-11-10' },
      { id: NaN, start_date: '', end_date: '', resources: [{ resource_id: NaN, quantity: 5 }, { resource_id: 2, quantity: NaN }] },
      { id: 5, start_date: '', end_date: '', resources: [{ resource_id: 3, quantity: undefined as unknown as number }, { resource_id: 4, quantity: null as unknown as number }] },
    ] }]
    const index = indexResourceDemand(processes)
    const previews: TaskPreview[] = [idle, ...[1, 2, 3, 4, 5, 99, NaN, null].map(taskId => ({ active: true, taskId, startDate: '2026-11-10', endDate: '2026-11-11' })),
      { active: true, taskId: 1, startDate: null, endDate: '2026-11-11' }, { active: true, taskId: 1, startDate: '', endDate: '' }]
    for (const resource of [1, 2, 3, 4, 99, NaN]) for (const day of ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', 'invalid']) for (const preview of previews) {
      expect(indexedResourceUsage(index, resource, toDate(day), preview)).toBe(reference(processes, resource, toDate(day), preview))
    }
  })

  it.each(demandSamples())('matches a reproducible plan over DST and ISO year boundaries: $zone sample $sample', ({ zone, sample, anchor, plans, previewTasks }) => {
    vi.stubEnv('TZ', zone)
    try {
      const date = (offset: number) => { const value = toDate(anchor); value.setDate(value.getDate() + offset); return value }
      const text = (offset: number) => { const day = date(offset); return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}` }
      const processes = plans.map(process => ({ tasks: process.tasks.map(task => ({
        id: task.id, start_date: text(task.start), end_date: text(task.end), resources: task.resources,
      })) }))
      const original = structuredClone(processes), index = indexResourceDemand(processes)
      const previews = [idle, { active: true, taskId: previewTasks[0], startDate: text(-1), endDate: text(5) },
        { active: true, taskId: previewTasks[1], startDate: text(7), endDate: text(14) }, { active: true, taskId: 99, startDate: text(0), endDate: text(1) }]
      for (let offset = -1; offset < 14; offset++) for (let resource = 1; resource <= 5; resource++) for (const preview of previews) {
        expect(indexedResourceUsage(index, resource, date(offset), preview), `${zone} sample ${sample} resource ${resource} day ${offset}`).toBe(reference(processes, resource, date(offset), preview))
      }
      expect(processes).toEqual(original)
    } finally { vi.unstubAllEnvs() }
  })

  it('rebuilds after confirmed, pending and rolled-back dates or assignments, but not for a held preview', () => {
    const processes = reactive([{ tasks: [{ id: 1, start_date: '2026-11-09', end_date: '2026-11-10', resources: [{ resource_id: 1, quantity: 2 }] }] }])
    let builds = 0
    const index = computed(() => { builds++; return indexResourceDemand(processes) })
    const task = processes[0]!.tasks[0]!, day = toDate('2026-11-11')
    expect(indexedResourceUsage(index.value, 1, day, idle)).toBe(0)
    const first = index.value
    expect(indexedResourceUsage(index.value, 1, day, { active: true, taskId: 1, startDate: task.start_date, endDate: '2026-11-11' })).toBe(2)
    expect(index.value).toBe(first); expect(builds).toBe(1)
    expect(indexedResourceUsage(index.value, 1, day, idle)).toBe(0)
    task.end_date = '2026-11-11'
    expect(indexedResourceUsage(index.value, 1, day, idle)).toBe(2)
    task.resources[0]!.quantity = 4
    expect(indexedResourceUsage(index.value, 1, day, idle)).toBe(4)
    task.resources.push({ resource_id: 2, quantity: 3 })
    expect(indexedResourceUsage(index.value, 2, day, idle)).toBe(3)
    task.start_date = '2026-11-10'
    expect(indexedResourceUsage(index.value, 1, toDate('2026-11-09'), idle)).toBe(0)
    task.start_date = '2026-11-09'
    expect(indexedResourceUsage(index.value, 1, toDate('2026-11-09'), idle)).toBe(4)
    task.end_date = '2026-11-10'
    expect(indexedResourceUsage(index.value, 1, day, idle)).toBe(0)
    task.resources.splice(0, 1)
    expect(indexedResourceUsage(index.value, 1, toDate('2026-11-09'), idle)).toBe(0)
    processes[0]!.tasks.splice(0, 1)
    expect(indexedResourceUsage(index.value, 2, toDate('2026-11-09'), idle)).toBe(0)
  })

  it('reads task dates only while indexing, independent of the number of displayed resources or days', () => {
    let dateReads = 0
    const processes = [{ tasks: Array.from({ length: 600 }, (_, id) => Object.freeze({ id,
      get start_date() { dateReads++; return '2026-11-09' }, get end_date() { dateReads++; return '2027-02-06' },
      resources: Object.freeze([{ resource_id: id % 60, quantity: 1 }]) as unknown as { resource_id: number; quantity: number }[],
    })) }]
    Object.freeze(processes[0]!.tasks); Object.freeze(processes[0]); Object.freeze(processes)
    const index = indexResourceDemand(processes)
    expect(dateReads).toBe(1200)
    for (let resource = 0; resource < 60; resource++) for (let day = 9; day < 16; day++) expect(indexedResourceUsage(index, resource, toDate(`2026-11-${day}`), idle)).toBe(10)
    expect(dateReads).toBe(1200)
  })

  it('keeps weekly peak, independent availability minimum and preview removal across a DST week', () => {
    vi.stubEnv('TZ', 'America/New_York')
    try {
      const processes = [{ tasks: [
        { id: 1, start_date: '2026-10-26', end_date: '2026-11-01', resources: [{ resource_id: 1, quantity: 1 }] },
        { id: 2, start_date: '2026-10-29', end_date: '2026-10-29', resources: [{ resource_id: 1, quantity: 9 }] },
      ] }]
      const index = indexResourceDemand(processes), available = (_: number, day: Date) => day.getDate() === 28 ? 0 : 1
      const cell = (preview: TaskPreview) => resourceCellUsage(1, toDate('2026-10-26'), toDate('2026-11-01'), (id, day) => indexedResourceUsage(index, id, day, preview), available)
      expect(cell(idle)).toEqual({ used: 10, available: 0, isWeekend: false })
      expect(cell({ active: true, taskId: 2, startDate: '2026-11-02', endDate: '2026-11-02' })).toEqual({ used: 1, available: 0, isWeekend: false })
    } finally { vi.unstubAllEnvs() }
  })
})
