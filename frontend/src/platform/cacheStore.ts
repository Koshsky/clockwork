import { idbPut, idbGet, idbKeys, idbClear } from '@/offline/db'
import { platformCapabilities } from './context'

// Web caches are disposable and never read, modify or adopt a legacy profile.
const memory = new Map<string, unknown>()
const optional = () => platformCapabilities.optionalStorage
const copy = <T>(value: T): T => structuredClone(value)

export async function optionalCachePut(store: 'cache', key: string, value: unknown): Promise<void> {
  if (optional()) { memory.set(key, copy(value)); return }
  await idbPut(store, key, value)
}

export async function optionalCacheGet<T>(store: 'cache', key: string): Promise<T | undefined> {
  return optional() ? copy(memory.get(key) as T | undefined) : idbGet<T>(store, key)
}

export async function optionalCacheKeys(store: 'cache'): Promise<string[]> {
  return optional() ? [...memory.keys()] : idbKeys(store)
}

export async function optionalCacheClear(store: 'cache'): Promise<void> {
  memory.clear()
  if (!optional()) await idbClear(store)
}
