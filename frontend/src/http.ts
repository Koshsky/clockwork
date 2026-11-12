import { readStamp, mayApplyRead } from './offline/mutationGuard'
import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios'
import router from './router'
import { apiErrorMessage } from './utils'
import { currentLocale, t } from './i18n'
import { notifyError } from './notify/state'
import { cacheGet, cacheGetByPath, cachePut, userCachePrefix } from './offline/cache'
import { replayOutboxToCache, scheduleReplayOutboxToCache, createMutationKey } from './offline/outbox'
import { isOffline } from './offline/state'
import { getAccessToken, accessTokenExpired } from './token'
import { ensureAutoSession } from './offline/sync'
import { isLoggedOut } from './loggedOut'

/** Paths where 401 does not mean "token expired" — we leave them alone (loop protection) */
const AUTH_PATHS = ['/auth/login', '/auth/refresh', '/auth/logout']

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retried?: boolean
}

/** Per-request opt-out from the global error notification: the caller owns the
 *  error UX itself (e.g. the outbox flush, whose SyncToast is its channel). */
interface SilentConfig extends InternalAxiosRequestConfig {
  silentError?: boolean
}

/** Full request URL prefixed by the current user (`u<id>:`+url) — the single
 *  cache key (both write and read). The prefix keeps each account's scoped
 *  responses separate: the Authorization header never enters the key, so
 *  without it the responses of different users would overwrite each other. */
function cacheKey(config: InternalAxiosRequestConfig): string {
  return userCachePrefix() + axios.getUri(config)
}

/** The single in-flight refresh for all parallel 401s */
let refreshing: Promise<boolean> | null = null

function redirectToLogin() {
  const current = router.currentRoute.value
  if (current.name !== 'login') {
    void router.push({ name: 'login', query: { redirect: current.fullPath } })
  }
}

/**
 * 401 interceptor: silently refreshes the access token via the refresh token
 * and retries the request. It runs on the shared axios instance used by all
 * generated API clients (src/api/base.ts: globalAxios).
 */
export function setupHttp() {
  const reads = new WeakMap<object, { stamp: number | null; prefix: string; key: string }>()
  // Never attach an EMPTY Authorization header ("Bearer ") — the backend
  // answers such requests with INVALID_TOKEN (invalid authorization format),
  // which the UI misreads as «Сессия истекла». Without a token the header is
  // simply omitted; protected endpoints then return a plain 401 that flows
  // through the normal refresh/retry path below.
  axios.interceptors.request.use((config) => {
    if ((config.method ?? 'get').toLowerCase() === 'get') {
      reads.set(config, { stamp: readStamp(), prefix: userCachePrefix(), key: cacheKey(config) })
    }
    const token = getAccessToken()
    config.headers = config.headers ?? {}
    const auth = String(config.headers['authorization'] || config.headers['Authorization'] || '')
    if (auth.startsWith('Bearer ') && !token) {
      delete config.headers['authorization']
      delete config.headers['Authorization']
    }
    // The backend localizes its messages per request (pkg/messages): send the
    // interface language so error texts arrive already translated. Resolved per
    // request, so a language switch applies to the next call.
    config.headers['Accept-Language'] = currentLocale()
    const method = (config.method ?? 'get').toLowerCase()
    if (!['get', 'head', 'options'].includes(method) && !config.url?.includes('/auth/')) {
      if (!config.headers.get('Idempotency-Key')) config.headers.set('Idempotency-Key', createMutationKey())
    }
    return config
  })

  // Successful GETs are written to the offline cache (network is up — data is fresh).
  // The cache and write-through overlay work in every environment (web and desktop).
  axios.interceptors.response.use(
    async (response) => {
      const { config, status } = response
      const read = reads.get(config)
      if (
        status >= 200 &&
        status < 300 &&
        config.method === 'get' &&
        config.url &&
        !AUTH_PATHS.some((path) => config.url!.includes(path)) &&
        !config.headers.get('X-View-User-ID') &&
        read != null && read.prefix === userCachePrefix() && mayApplyRead(read.stamp)
      ) {
        // A delayed reply must never be written under a newly logged-in account.
        await cachePut(read.key, response.data)
        // Invariant "cache = server + queue": after a fresh write we re-apply
        // unsynchronized mutations — warmup/reconcile must not erase them with
        // server truth (otherwise offline edits are lost after a reload).
        // Coalesced: a burst of parallel GETs schedules a single replay for the
        // whole tick instead of one full outbox+cache scan per response.
        scheduleReplayOutboxToCache()
      }
      return response
    },
    async (error: AxiosError) => {
      const { config } = error
      if (!config) {
        return Promise.reject(error)
      }
      const read = reads.get(config)
      if (read && read.prefix !== userCachePrefix()) return Promise.reject(error)

      // Server unreachable (network, timeout, abort — any request without an HTTP response):
      // serve the last saved response from the cache (same { data, error } format). Read-time
      // overlay: before reading we apply unsynchronized mutations on top of the warmed cache.
      // This runs in every environment — web and desktop share the same offline read path.
      if (!error.response && config.headers?.get('X-View-User-ID')) return Promise.reject(error)
      if (!error.response) {
        if ((config.method ?? 'get').toLowerCase() === 'get') {
          await replayOutboxToCache()
          if (read?.prefix !== userCachePrefix()) return Promise.reject(error)
          const key = read.key
          let cached = await cacheGet<unknown>(key)
          // The exact key may not match (a GET with a date window depends on "today"
          // and differs after warmup) — look up the fresh response by endpoint.
          if (cached == null) {
            const pathname = (() => {
              try {
                return new URL(key).pathname
              } catch {
                return key.split('?')[0]
              }
            })()
            cached = await cacheGetByPath<unknown>(pathname)
          }
          if (read.prefix !== userCachePrefix()) return Promise.reject(error)
          if (cached != null) {
            isOffline.value = true
            console.log(`[offline] served cache: ${key}`)
            return {
              __erpLocalSnapshot: true,
              data: cached,
              status: 200,
              statusText: 'OK',
              headers: {},
              config,
              request: error.request,
            }
          }
          ;(error as AxiosError & { message: string }).message = t('offline.noCachedData')
          console.log(`[offline] cache miss: ${key}`)
        }
        // Network error diagnostics (timeout/drop/CORS/abort) — detailed output to the console.
        const ax = error as AxiosError & { code?: string; timeout?: number }
        console.error(
          // i18n-allow: developer console diagnostics, never rendered in the UI
          `[http] network error (no HTTP response): ${(config.method || 'get').toUpperCase()} ${config.url ?? ''}`,
          {
            kind: 'network',
            code: ax.code,
            timeout_ms: ax.timeout,
            message: ax.message,
            data: config.data,
          },
        )
        return Promise.reject(error)
      }

      const { response } = error
      if (!response) {
        return Promise.reject(error)
      }

      // Substitute the local error text from the response body ({ data, error })
      // instead of "Request failed with status code …" so the store shows the reason.
      if (response.status >= 400) {
        const body = response.data as { error?: { message?: string; code?: string | number } } | undefined
        if (body?.error) {
          ;(error as AxiosError & { message: string }).message = apiErrorMessage(body.error)
        }
      }

      // Global error notification for FAILED MUTATIONS (non-GET). Reads keep
      // their inline/empty-state rendering — no toast — so background refreshes
      // stay silent; the auth machinery owns the 401 UX (refresh, redirect to
      // login) and silent-flagged requests (outbox flush) handle their own
      // feedback. The message priority: backend body → axios text.
      if (
        response.status >= 400 &&
        response.status !== 401 &&
        (config.method ?? 'get').toLowerCase() !== 'get' &&
        !(config as SilentConfig).silentError &&
        !AUTH_PATHS.some((path) => (config.url ?? '').includes(path))
      ) {
        const body = response.data as { error?: { message?: string; code?: string | number } } | undefined
        notifyError(apiErrorMessage(body?.error, error.message))
      }

      if (response.status !== 401) {
        return Promise.reject(error)
      }

      const url = config.url ?? ''
      if (AUTH_PATHS.some((path) => url.includes(path))) {
        return Promise.reject(error)
      }

      // The user explicitly logged out: do not try to restore the session.
      // The refresh cookie is already revoked by the server, /auth/refresh would return 401,
      // and reusing a revoked token is treated by the server as
      // reuse (revoking ALL user sessions) — plus the UI would show a false
      // "Session expired" instead of the expected "logged out" state.
      if (isLoggedOut()) {
        // The router must see the cleared in-memory state before entering /login.
        await ensureAutoSession()
        redirectToLogin()
        return Promise.reject(error)
      }

      if ((config as RetryableConfig)._retried) {
        return Promise.reject(error)
      }

      // A delayed 401 can belong to a request sent before session restoration.
      const sent = String(config.headers.get('Authorization') ?? '')
      if (accessTokenExpired() || sent === `Bearer ${getAccessToken()}`) {
        refreshing ??= ensureAutoSession().finally(() => {
          refreshing = null
        })
        if (!(await refreshing)) {
          redirectToLogin()
          return Promise.reject(error)
        }
      }

      // Never retry with an EMPTY bearer: the server answers «invalid
      // authorization format» (INVALID_TOKEN) and the UI shows a misleading
      // «Сессия истекла». If no token could be restored, send the user to the
      // login page instead of firing a request that is guaranteed to fail.
      const token = getAccessToken()
      if (!token) {
        redirectToLogin()
        return Promise.reject(error)
      }

      ;(config as RetryableConfig)._retried = true
      config.headers = config.headers ?? {}
      delete config.headers['authorization']
      config.headers['Authorization'] = `Bearer ${token}`
      return axios(config)
    },
  )
}
