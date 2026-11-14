export type RevisionBaseline = Record<string, string>
export function periodRowBaseline(row: { _baseline?: RevisionBaseline; _pending?: Record<string, string> }): RevisionBaseline | undefined {
  if (!row._baseline) return undefined
  return Object.fromEntries(Object.entries(row._baseline).map(([key, token]) => [key, row._pending?.[key] ? 'local:' + row._pending[key] : token]))
}
interface WindowBaseline { start: string; end: string; baseline: RevisionBaseline }

export function createPeriodBaselines() {
  const employees = new Map<number, WindowBaseline[]>()
  const same = (left: RevisionBaseline, right: RevisionBaseline) => Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, value]) => right[key] === value)
  return {
    record(id: number, start: string, end: string, baseline?: RevisionBaseline) {
      if (!baseline || !start || !end) return
      const windows = employees.get(id) ?? []
      employees.set(id, [...windows.filter(window => window.start !== start || window.end !== end), { start, end, baseline: { ...baseline } }])
    },
    capture(id: number, start: string, end: string): RevisionBaseline | undefined {
      const windows = employees.get(id) ?? []
      const covering = [...windows].reverse().find(window => window.start <= start && window.end >= end)
      if (!covering || windows.some(window => window.start <= end && window.end >= start && !same(window.baseline, covering.baseline))) return undefined
      return { ...covering.baseline }
    },
    advance(id: number, previous: RevisionBaseline, next: RevisionBaseline) {
      for (const window of employees.get(id) ?? []) {
        if (Object.entries(window.baseline).every(([key, token]) => previous[key] === token && typeof next[key] === 'string')) window.baseline = Object.fromEntries(Object.keys(window.baseline).map(key => [key, next[key]!]))
      }
    },
    clear() { employees.clear() },
  }
}
