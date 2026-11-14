const memory = new Map<string, unknown>()
const copy = <T>(value: T): T => structuredClone(value)

export async function optionalCachePut(_store: 'cache', key: string, value: unknown): Promise<void> { memory.set(key, copy(value)) }
export async function optionalCacheGet<T>(_store: 'cache', key: string): Promise<T | undefined> { return copy(memory.get(key) as T | undefined) }
export async function optionalCacheKeys(_store: 'cache'): Promise<string[]> { return [...memory.keys()] }
export async function optionalCacheClear(_store: 'cache'): Promise<void> { memory.clear() }
