const refreshers = new Map<symbol, () => Promise<unknown>>()
let suspended = false
let generation = 0
let running: Promise<number> | null = null
export function registerActiveRead(refresh: () => Promise<unknown>): () => void {
  const key = Symbol()
  refreshers.set(key, refresh)
  return () => { refreshers.delete(key) }
}
export function refreshActiveReads(): Promise<number> {
  if (suspended) return Promise.resolve(0)
  if (running) return running
  const own = generation
  running = (async () => {
    let count = 0
    for (const [key, refresh] of [...refreshers]) {
      if (suspended || own !== generation) break
      if (!refreshers.has(key)) continue
      try { if (await refresh() !== false) count++ } catch { /* The page owns its read error. */ }
    }
    return count
  })().finally(() => { if (own === generation) running = null })
  return running
}
export function stopActiveReads(): void { suspended = true; generation++; running = null }
export function resumeActiveReads(): void { suspended = false }
