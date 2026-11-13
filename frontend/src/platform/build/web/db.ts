import type * as Legacy from '@/offline/db'

// A web artifact must fail closed even if a future caller bypasses its capabilities.
const unavailable = async (): Promise<never> => { throw new Error('WEB_OFFLINE_STORAGE_UNAVAILABLE') }
export const idbPut: typeof Legacy.idbPut = unavailable
export const idbGet: typeof Legacy.idbGet = unavailable
export const idbDel: typeof Legacy.idbDel = unavailable
export const idbAll: typeof Legacy.idbAll = unavailable
export const idbKeys: typeof Legacy.idbKeys = unavailable
export const idbCount: typeof Legacy.idbCount = unavailable
export const idbClear: typeof Legacy.idbClear = unavailable
export const IDMAP_STORE_NAME = 'idmap'
export type { IdMapEntry } from '@/offline/db'
