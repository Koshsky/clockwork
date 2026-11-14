/**
 * Minimal promise wrapper over IndexedDB (no external dependencies).
 * A single `erp-offline` database with stores:
 *  - `cache`  — API response cache (GET);
 *  - `outbox` — mutation queue for offline writes (create/update/delete);
 *  - `idmap`  — persistent mapping of temporary (negative) ids of created
 *    offline entities to real ids, so dependent records are sent with the
 *    real id (not a fake one) after sync interruptions.
 *  - `session` — the single non-volatile refresh token store (for all
 *    environments: web + desktop), the "remember me" for auto-session.
 *
 * NO-TTL INVARIANT: the local stores (cache/outbox/idmap/session) have no
 * TTL and are never cleaned up by time/age/timers. Data is removed only by:
 *  - explicit user actions (clearOutbox, discardFailed /
 *    discardEntry for rejected queue entries);
 *  - an app-version change (ensureCacheVersion — clears ONLY the cache);
 *  - a verified online login pruning the queue entries of the logged-out
 *    previous account (their session is revoked and the flush-time creator
 *    guard would park them forever); logout itself no longer wipes the queue
 *    (a sibling tab of the same user loses its pending work — see H-OFF-3).
 * Server-side TTLs (refresh session 168h, access token 15m) are validated only
 * by the backend. See docs/no-ttl-local-storage.md.
 */

import { t } from '../i18n'
import { localDataAvailability } from '@/platform/state'

const DB_NAME = 'erp-offline'
// The schema version this build knows. It is NOT passed to indexedDB.open
// directly: an existing database (created by an older bundle or bumped by our
// own store repair) may already be above it, and requesting a lower version
// fails with a VersionError. openDb() opens at the current version and only
// bumps when an object store is missing. Kept as documentation of the schema
// generation (unused otherwise).
const _DB_VERSION = 4
const CACHE_STORE = 'cache'
const OUTBOX_STORE = 'outbox'
const IDMAP_STORE = 'idmap'
const SESSION_STORE = 'session'

/** Every object store the app relies on (must all exist after openDb). */
const ALL_STORES = [CACHE_STORE, OUTBOX_STORE, IDMAP_STORE, SESSION_STORE] as const

const DB_OPERATION_TIMEOUT_MS = 4000

let dbPromise: Promise<IDBDatabase> | null = null
let activeDb: IDBDatabase | null = null
const transactions = new WeakMap<IDBDatabase, number>()

/** Creates any missing object store (runs inside onupgradeneeded). */
function ensureStores(db: IDBDatabase): void {
  for (const name of ALL_STORES) {
    if (!db.objectStoreNames.contains(name)) {
      db.createObjectStore(name)
    }
  }
}

/** Whether the connection has every required object store. */
function hasAllStores(db: IDBDatabase): boolean {
  return ALL_STORES.every((name) => db.objectStoreNames.contains(name))
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error(t('offline.db.unavailable')))
      return
    }

    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    }
    // Opening and schema repair share a deadline: a legacy tab can block an upgrade indefinitely.
    const timer = setTimeout(() => fail(new Error(t('offline.db.timeout'))), DB_OPERATION_TIMEOUT_MS)
    const connect = (version?: number) => {
      const request = version == null ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version)
      request.onupgradeneeded = () => {
        if (settled) {
          request.transaction?.abort()
          return
        }
        ensureStores(request.result)
      }
      request.onerror = () => fail(request.error ?? new Error(t('offline.db.openFailed')))
      request.onsuccess = () => {
        const db = request.result
        // A timed-out open must not retain a handle or perform a delayed schema repair.
        if (settled) {
          db.close()
          return
        }
        if (!hasAllStores(db)) {
          const repairedVersion = db.version + 1
          db.close()
          try {
            connect(repairedVersion)
          } catch (error) {
            fail(error)
          }
          return
        }
        activeDb = db
        db.onversionchange = () => {
          resetDb(db)
          db.close()
        }
        db.onclose = () => resetDb(db)
        settled = true
        clearTimeout(timer)
        resolve(db)
      }
    }
    try {
      // Accept newer schemas; only upgrade if a required store is actually missing.
      connect()
    } catch (error) {
      fail(error)
    }
  })
}

function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const pending = openDb().catch((error) => {
      localDataAvailability.value = 'unavailable'
      if (dbPromise === pending) dbPromise = null
      throw error
    })
    dbPromise = pending
  }
  return dbPromise
}

function resetDb(db: IDBDatabase): void {
  // An event from an old handle must not invalidate its replacement.
  if (activeDb !== db) return
  activeDb = null
  dbPromise = null
}

async function txAll(
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest,
): Promise<IDBRequest['result']> {
  const db = await getDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode)
    transactions.set(db, (transactions.get(db) ?? 0) + 1)
    const release = () => {
      const remaining = (transactions.get(db) ?? 1) - 1
      transactions.set(db, remaining)
      if (remaining === 0) {
        // An idle or suspended tab must not block another tab's schema upgrade.
        resetDb(db)
        db.close()
      }
    }
    let settled = false
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      localDataAvailability.value = 'unavailable'
      clearTimeout(timer)
      release()
      reject(error ?? new Error(t('offline.db.operationFailed')))
    }
    const timer = setTimeout(() => {
      fail(new Error(t('offline.db.timeout')))
      // Cancel pending writes as well as rejecting: a late refresh write could replace a newer token.
      try { tx.abort() } catch { /* The transaction may already have finished. */ }
    }, DB_OPERATION_TIMEOUT_MS)
    tx.onabort = () => fail(tx.error)
    tx.onerror = () => fail(tx.error)
    try {
      const req = fn(tx.objectStore(store))
      tx.oncomplete = () => {
        if (settled) return
        settled = true
        localDataAvailability.value = 'available'
        clearTimeout(timer)
        release()
        resolve(req.result)
      }
      req.onerror = () => fail(req.error)
    } catch (error) {
      fail(error)
      try { tx.abort() } catch { /* No transaction remains to cancel. */ }
    }
  })
}

export async function idbPut(store: string, key: string, value: unknown): Promise<void> {
  await txAll(store, 'readwrite', (s) => s.put(value, key))
}

export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const result = await txAll(store, 'readonly', (s) => s.get(key))
  return result as T | undefined
}

export async function idbDel(store: string, key: string): Promise<void> {
  await txAll(store, 'readwrite', (s) => s.delete(key))
}

export async function idbAll<T>(store: string): Promise<T[]> {
  const result = await txAll(store, 'readonly', (s) => s.getAll())
  return (result ?? []) as T[]
}

export async function idbKeys(store: string): Promise<string[]> {
  const result = await txAll(store, 'readonly', (s) => s.getAllKeys())
  return (result ?? []) as string[]
}

export async function idbCount(store: string): Promise<number> {
  const result = await txAll(store, 'readonly', (s) => s.count())
  return typeof result === 'number' ? result : 0
}

export async function idbClear(store: string): Promise<void> {
  await txAll(store, 'readwrite', (s) => s.clear())
}

export const IDMAP_STORE_NAME = IDMAP_STORE

/** Mapping of a temporary (negative) offline-creation id to the real server id */
export interface IdMapEntry {
  temp: number
  real: number
}
