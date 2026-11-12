import { idbPut, idbGet, idbKeys, idbClear } from '@/offline/db'
import { platformCapabilities } from './context'
import { legacyQueueAvailability, localDataAvailability } from './state'

// This fallback is only a disposable GET cache. Queue/ID-map writes must always
// use the durable database and must never be acknowledged by an in-memory store.
const memory = new Map<string, unknown>()
const volatileKeys = new Set<string>()
const optional = () => platformCapabilities.optionalStorage
const tryDisk = () => !optional() || localDataAvailability.value !== 'unavailable'
const readDisk = () => !optional() || legacyQueueAvailability.value === 'pending'
const copy = <T>(value: T): T => structuredClone(value)

export async function optionalCachePut(store: 'cache', key: string, value: unknown): Promise<void> {
  if (optional()) { memory.set(key, copy(value)); volatileKeys.add(key) }
  if (!tryDisk()) return
  try { await idbPut(store, key, value); volatileKeys.delete(key) } catch (error) { if (!optional()) throw error }
}

export async function optionalCacheGet<T>(store: 'cache', key: string): Promise<T | undefined> {
  if (optional() && (volatileKeys.has(key) || !readDisk())) return copy(memory.get(key) as T | undefined)
  if (readDisk() && tryDisk()) {
    try {
      const value = await idbGet<T>(store, key)
      if (value !== undefined) {
        if (optional()) memory.set(key, copy(value))
        return value
      }
    } catch (error) { if (!optional()) throw error }
  }
  return optional() ? copy(memory.get(key) as T | undefined) : undefined
}

export async function optionalCacheKeys(store: 'cache'): Promise<string[]> {
  const keys = optional() ? [...memory.keys()] : []
  if (readDisk() && tryDisk()) {
    try { keys.push(...await idbKeys(store)) } catch (error) { if (!optional()) throw error }
  }
  return [...new Set(keys)]
}

export async function optionalCacheClear(store: 'cache'): Promise<void> {
  memory.clear()
  volatileKeys.clear()
  if (!tryDisk()) return
  try { await idbClear(store) } catch (error) { if (!optional()) throw error }
}
