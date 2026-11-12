import { defineStore } from 'pinia'
import { ref, computed, watch, onScopeDispose, hasInjectionContext, inject } from 'vue'
import axios, { type AxiosError, type Method } from 'axios'
import { AuthApi, ProjectsApi, ProcessesApi, TasksApi, TimesheetResourcesApi, TimesheetCalendarApi, TimesheetStatesApi, PlanningApi, MilestonesApi, UsersApi, AssignmentsApi, AutoCreateApi, RBACApi, PermissionsApi, AuditApi, Configuration } from '@/api'
import type { DtoUserInfo, DtoProject, DtoResourceResponse, DtoResourceCalendar, DtoResourceMemberResponse, DtoResourceAbsenceResponse, DtoUserResponse, DtoUserStateResponse, DtoStateResponse, DtoCreateResourceRequest, DtoUpdateResourceRequest, DtoCreateUserRequest, DtoUpdateUserRequest, DtoAdminUserResponse, DtoCreateUserResult, DtoAutoCreateConfig, DtoAutoCreatedCounts, DtoCommentResponse, DtoPresetView, DtoPresetRuleInput, DtoPresetRuleView, DtoMatrixCell, DtoRoutePolicyView, EngineKindInfo, DtoPermission, DtoUserPermissionsView, DtoUserPermissionsInput, DtoAuditEventView, DtoAssignmentResponse, DtoDetailedProcess, DtoDetailedProject, DtoDetailedTask, DtoTaskResponse, DtoUpdateTaskRequest, DtoMilestone, DtoProcess, DtoProcessPlanning, DtoProjectPlanning, DtoResource, DtoTaskDependency, DtoTaskPlanning } from '@/api'
import { apiErrorMessage } from '@/utils'
import { t } from '@/i18n'
import { getApiUrl } from '@/config'
import { tablePageSize } from '@/settings'
import { isOffline } from '@/offline/state'
import { offlineFailFastAdapter } from '@/offline/failFast'
import { scheduleWarmup } from '@/offline/warmup'
import { enqueueMutation, isNetworkError, pruneForeignOutbox } from '@/offline/outbox'
import { scheduleDomainRefresh } from '@/offline/sync'
import { applyRangeSplit, mergePeriodWindow, replaceEmployeeAbsences, shiftPeriodDate as shiftDate } from '@/domain/timesheet'
import { updatePeriodAvailability } from '@/domain/periodAvailability'
import { assignmentAllowed } from '@/domain/resourceUsage'
import { findPlanningTask, findTaskProcess, reorderItems, projectPriorityChanges, taskDateRollback, addResourceAssignment, removeResourceAssignment } from '@/domain/planning'
import { beginMutation, readStamp, mayApplyRead } from '@/offline/mutationGuard'
import { pendingRefs } from '@/offline/outbox'
import { getAccessToken, setAccessToken, accessTokenExpired, accessTokenExpiresAt } from '@/token'
import {
  withRefreshLock,
  publishSession,
  subscribeSession,
  subscribeToken,
} from '@/sessionSync'
import { isLoggedOut, clearLoggedOut, setLoggedOut } from '@/loggedOut'
import { saveRefreshToken, loadRefreshToken, clearRefreshToken } from '@/offline/session'
import { createTemporaryId } from '@/offline/temporaryId'
import { hydrateFromCache, apiPath } from '@/offline/hydrate'
import { cacheGetAllByPath } from '@/offline/cache'
import { createReadGuard } from '@/data/readGuard'
import { taskDataKey } from '@/data/taskData'
import { createLegacyTaskData } from './data/legacyTasks'
import { runMutation } from './data/legacyMutation'
import { evalScope, type ScopeProbe } from '@/rbacScope'
import { parentScope } from '@/utils/presetDefaults'
import {
  resolveTaskMove,
  resolveAddDependency,
  resolveEdges,
  persistenceOrder,
  type DependencyEdge,
  type DependencyType,
  type TaskDates,
  type TaskDatePatch,
} from '@/domain/dependencies'

const USER_KEY = 'mvs_erp_user'
/**
 * Cache of my RBAC permissions for offline mode — PER-USER: permissions are a
 * user-specific matrix (preset + ACL grants/revokes + admin bypass), so the
 * cache key carries the user id and a logout removes the whole key. Another
 * account must never pick up a previous login's cached rights.
 */
const PERMS_KEY_PREFIX = 'mvs_erp_perms'
function permsKey(uid: number | null | undefined): string {
  return uid != null ? `${PERMS_KEY_PREFIX}_${uid}` : PERMS_KEY_PREFIX
}

/** How long before the token expires that proactive refresh kicks in */
const REFRESH_MARGIN_MS = 120 * 1000
const REFRESH_INTERVAL_MS = 30 * 1000
const SIBLING_REFRESH_WAIT_MS = 6000

/** Page size for listings (matches the backend default). */
// Paged lists use the live UI setting (tablePageSize) — see the API calls below.

/** Max employee ids per batch days request (backend contract — see GET /user/days). */
const BATCH_IDS_MAX = 200

/** Temporary (negative) id for entities created offline (unique over time) */
function nextTempId(): number {
  return createTemporaryId()
}

function apiConfig(): Configuration {
  return new Configuration({
    basePath: getApiUrl(),
    baseOptions: {
      headers: { 'Content-Type': 'application/json' },
      // Fail fast (10 s) on an unreachable backend: axios defaults to no timeout,
      // and a hanging server used to freeze the UI indefinitely — most critically
      // the silent auto re-login before first paint (see main.ts BOOT_BOUND_MS).
      timeout: 10000,
      // Fail-fast when offline is known (the banner is up): the request does not go
      // to the network or wait for a timeout — mutations immediately land in the outbox
      // queue, GETs are served from cache. The adapter is only placed here (store clients)
      // so that the queue flush (flushOutbox, raw axios) goes to the network as
      // usual: otherwise, once the network is back, writes would fail with Network Error.
      ...(isOffline.value ? { adapter: offlineFailFastAdapter } : {}),
    },
    apiKey: () => `Bearer ${getAccessToken()}`,
  })
}

/**
 * Configuration for AUTH requests only (/auth/login, /auth/refresh,
 * /auth/logout). These must ALWAYS reach the network — even while isOffline is
 * true: they are precisely how the app verifies the server came back (manual
 * online login, silent session restore). The fail-fast adapter would otherwise
 * swallow the login attempt while the monitor still thinks the server is dead,
 * leaving the user stuck on /login with no way to reconnect.
 */
function authApiConfig(): Configuration {
  return new Configuration({
    basePath: getApiUrl(),
    baseOptions: {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    },
    apiKey: () => `Bearer ${getAccessToken()}`,
  })
}

export { apiConfig }

function readStoredUser(): DtoUserInfo | null {
  try {
    const raw = localStorage.getItem(USER_KEY)
    return raw ? (JSON.parse(raw) as DtoUserInfo) : null
  } catch {
    return null
  }
}

/** Whether the token should be renewed early (less than the margin left until expiry) */
function accessTokenExpiring(): boolean {
  const exp = accessTokenExpiresAt()
  if (exp == null) return true
  return exp - Date.now() <= REFRESH_MARGIN_MS
}

/** Wait for a valid sibling token; timeout is a retry signal, never refresh success. */
function waitForExternalToken(previous: string): Promise<boolean> {
  const renewed = () => getAccessToken() !== previous && !accessTokenExpired()
  if (renewed()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      unsub()
      resolve(renewed())
    }, 2000)
    const unsub = subscribeToken((token) => {
      const cur = accessTokenExpiresAt(getAccessToken())
      const next = accessTokenExpiresAt(token)
      if (isLoggedOut() || token === previous || next == null || next <= Date.now() || (cur != null && next < cur)) return
      if (cur == null || next >= cur) setAccessToken(token)
      window.clearTimeout(timer)
      unsub()
      resolve(renewed())
    })
  })
}

// === Auth ===
export const useAuthStore = defineStore('auth', () => {
  // Cached identity supports session restoration, but cannot override a recorded logout.
  const user = ref<DtoUserInfo | null>(readStoredUser())
  const isAuthenticated = ref<boolean>(Boolean(user.value) && !isLoggedOut())
  // Neither the in-memory token nor the wall clock invalidates a Vue computed value.
  function accessExpired(): boolean { return accessTokenExpired() }
  /** Session mode: online — real (with token), offline — local without token */
  const sessionMode = ref<'online' | 'offline'>('online')
  const loading = ref(false)
  const error = ref<string | null>(null)

  /**
   * Applies a session (login or silent rotation).
   *
   * `warm` must be true ONLY for a manual login: the periodic token rotation
   * (startSessionMaintenance / the proactive timer / the 401 interceptor) used
   * to schedule a FULL warmup on every refresh. On the "Табель" page that
   * re-fetched the roster and all employee periods every 30 s, replacing the
   * employees array with a fresh one each time — the grid re-rendered and the
   * page looked like it was constantly reloading and flickering. A rotation
   * changes nothing about the data, so it must not touch it: freshness is the
   * background PULL cycle's job (offline/connection.ts).
   */
  function applySession(
    data: { access_token?: string; user?: DtoUserInfo } | undefined,
    warm = false,
  ) {
    const prevUid = user.value?.id
    const token = data?.access_token
    setAccessToken(token ?? null)
    if (data?.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(data.user))
      user.value = data.user
    }
    isAuthenticated.value = Boolean(token)
    sessionMode.value = 'online'
    scheduleProactiveRefresh()
    // Permission isolation: when a different user id arrives (a login or an
    // account switch) drop the stale in-memory permission snapshot and fetch
    // the new account's real rights immediately — the UI must never show the
    // previous account's matrix. A token rotation keeps the same user, so
    // nothing to do (the TTL pull cycle owns refreshes).
    if (prevUid !== user.value?.id) {
      const rbac = useRbacStore()
      rbac.resetPermissions()
      if (!isOffline.value) void rbac.refreshPermissions()
    }
    // Background warm-up of the offline cache with data for the user's role
    if (warm) scheduleWarmup()
  }

  /**
   * Offline login (Desktop, the button on /login when isOffline): a local session
   * without a token — data from cache, mutations to the queue, the server is not polled.
   * Identity: the saved profile (if it matches the entered login or no login was
   * entered), otherwise a minimal profile with the entered login.
   */
  function enterOffline(username: string | null): boolean {
    const stored = readStoredUser()
    const prevUid = user.value?.id
    if (stored?.username && (!username || stored.username === username)) {
      user.value = stored
    } else {
      user.value = { username: username ?? undefined } as DtoUserInfo
    }
    setAccessToken(null)
    stopProactiveRefresh()
    isAuthenticated.value = true
    sessionMode.value = 'offline'
    // Offline account switch — never keep another profile's permissions.
    if (prevUid !== user.value?.id) useRbacStore().resetPermissions()
    return true
  }

  // Once the network returns after an offline login, silently try to restore a
  // real online session (the refresh token is in IndexedDB or the cookie). The
  // router guard alone cannot do it: it skips the refresh while isOffline is
  // true and then admits the stored profile without an access token — which
  // made every request go out with an empty Bearer and the server answered
  // INVALID_TOKEN («Сессия истекла»). When no refresh token is available at
  // all (a pure offline session), do nothing: the user stays offline (their
  // data and queue are intact) and can log in online explicitly.
  watch(
    isOffline,
    (offline) => {
      if (offline) return
      if (sessionMode.value !== 'offline') return
      if (isLoggedOut()) return
      void (async () => {
        const stored = await loadRefreshToken()
        if (stored == null) return // no session to restore — stay offline
        await refreshSession()
      })()
    },
    { flush: 'sync' },
  )

  async function login(username: string, password: string) {
    loading.value = true
    error.value = null
    try {
      const api = new AuthApi(authApiConfig())
      const resp = await api.authLoginPost({ username: username.trim(), password })
      const body = resp.data
      const errBody = body?.error as { code?: unknown; message?: string } | undefined
      if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
      // Commit shared state before publishing authentication to navigation watchers.
      if (body?.data?.refresh_token) {
        await saveRefreshToken(body.data.refresh_token)
      }
      clearLoggedOut()
      // Manual login: the offline cache is warmed for the user's role.
      applySession(body?.data, true)
      sessionMode.value = 'online'
      // A verified login orphans the queue entries of the previous account
      // (their session is revoked; the flush-time creator guard would park
      // them forever). Same-account entries — e.g. pending work of a sibling
      // tab — are kept. Non-fatal.
      void pruneForeignOutbox(user.value?.username ?? username.trim()).catch(() => {})
      return true
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      return false
    } finally {
      loading.value = false
    }
  }

  async function changePassword(oldPassword: string, newPassword: string) {
    loading.value = true
    error.value = null
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userChangePasswordPost({
        old_password: oldPassword,
        new_password: newPassword,
      })
      const body = resp.data
      const errBody = body?.error as { code?: unknown; message?: string } | undefined
      if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
      return true
    } catch (e: unknown) {
      error.value = apiErrorMessage(
        (e as { response?: { data?: { error?: { message?: string; code?: unknown } | null | undefined } } } | undefined)
          ?.response?.data?.error,
        e instanceof Error ? e.message : String(e),
      )
      return false
    } finally {
      loading.value = false
    }
  }

  let backgroundSessionAllowed = true
  let proactiveTimer: number | null = null
  let onVisibilityChange: (() => void) | null = null
  let refreshInFlight: Promise<boolean> | null = null

  /** Proactive refresh: timer + tab visibility return, so the access token never expires prematurely */
  function scheduleProactiveRefresh() {
    if (!backgroundSessionAllowed || proactiveTimer != null) return
    // Refresh is unified across environments: the refresh token lives in the
    // IndexedDB 'session' store (body of /auth/refresh), so the timer works the
    // same on web and desktop.
    const renew = () => {
      if (accessTokenExpiring()) {
        void refreshSession()
      }
    }
    proactiveTimer = window.setInterval(renew, REFRESH_INTERVAL_MS)
    onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && accessTokenExpiring()) {
        void refreshSession()
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
  }

  function stopProactiveRefresh() {
    if (proactiveTimer != null) {
      clearInterval(proactiveTimer)
      proactiveTimer = null
    }
    if (onVisibilityChange) {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      onVisibilityChange = null
    }
  }

  function invalidateOnlineSession() {
    stopProactiveRefresh()
    setAccessToken(null)
    isAuthenticated.value = false
    useRbacStore().resetPermissions()
    useTimesheetStore().resetUserData()
    useAppStore().resetUserData()
    usePlanningStore().resetUserData()
  }

  /** Renews the access token via the refresh token; on failure logs out.
   *  Parallel calls (timer/guard/interceptor) are deduplicated into a single request */
  async function refreshSession(): Promise<boolean> {
    // A sibling logout can leave this tab's cached profile and memory intact.
    if (isLoggedOut() && !isOffline.value) {
      invalidateOnlineSession()
      return false
    }
    if (refreshInFlight) return refreshInFlight
    refreshInFlight = doRefresh()
    try {
      return await refreshInFlight
    } finally {
      refreshInFlight = null
    }
  }

  async function waitForSessionRefresh(): Promise<void> {
    await refreshInFlight
  }

  async function doRefresh(): Promise<boolean> {
    const previous = getAccessToken()
    const deadline = Date.now() + SIBLING_REFRESH_WAIT_MS
    while (true) {
      if (isOffline.value) return true
      if (isLoggedOut()) {
        invalidateOnlineSession()
        return false
      }
      if (getAccessToken() !== previous && !accessTokenExpired()) return true
      if (Date.now() >= deadline) {
        error.value = t('auth.sessionBusy')
        return false
      }
      const renewed = await withRefreshLock(async () => {
        // A sibling may finish between the retry timer and lock acquisition.
        if (getAccessToken() !== previous && !accessTokenExpired()) return true
        return refreshOwnedSession()
      })
      if (renewed != null) return renewed
      if (await waitForExternalToken(previous)) return true
    }
  }

  async function refreshOwnedSession(): Promise<boolean> {
    let rotated = false
    loading.value = true
    error.value = null
    try {
      const api = new AuthApi(authApiConfig())
      const stored = await loadRefreshToken()
      const resp = await api.authRefreshPost(stored ? { refresh_token: stored } : undefined)
      const body = resp.data
      const errBody = body?.error as { code?: unknown; message?: string } | undefined
      if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
      // A response issued before logout must not resurrect the online session.
      if (isLoggedOut()) {
        invalidateOnlineSession()
        return false
      }
      // Rotate: persist the refresh token returned by the backend for the next refresh.
      if (body?.data?.refresh_token) {
        rotated = true
        await saveRefreshToken(body.data.refresh_token)
      }
      if (isLoggedOut()) {
        invalidateOnlineSession()
        return false
      }
      applySession(body?.data)
      const token = getAccessToken()
      if (token) {
        publishSession({ access: token, refresh: body?.data?.refresh_token })
      }
      return true
    } catch (e: unknown) {
      // Network error (no HTTP response): the server is unreachable. We do not log out —
      // we switch to offline mode (the session and the change queue in IndexedDB live
      // until the network returns), in every environment. Logout happens only on a
      // real server failure.
      if (isNetworkError(e)) {
        isOffline.value = true
        return true
      }
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      // Storage failures and transient server errors do not revoke a shared session.
      const status = (e as AxiosError)?.response?.status
      if (status === 401 || status === 403) logout()
      else if (rotated) {
        // The stored token is now revoked; no tab may reuse it after a failed rotation commit.
        invalidateOnlineSession()
        setLoggedOut()
      }
      return false
    } finally {
      loading.value = false
    }
  }

  function startBackgroundSession(): void {
    backgroundSessionAllowed = true
    if (isAuthenticated.value && sessionMode.value === 'online') scheduleProactiveRefresh()
  }

  function stopBackgroundSession(): void {
    backgroundSessionAllowed = false
    stopProactiveRefresh()
  }

  onScopeDispose(stopBackgroundSession)

  function logout() {
    stopProactiveRefresh()
    // The mutation queue is NOT wiped here: it is shared by every tab/window of
    // this profile, and a sibling tab of the same user may still have pending
    // edits (H-OFF-3). A foreign account can never flush someone else's queue —
    // the flush-time creator guard parks mismatched entries, and after a logout
    // auto-sync is disabled (isLoggedOut) until a manual login. Orphaned
    // entries of the logged-out account are pruned on the next verified login
    // (pruneForeignOutbox). The explicit full wipe is clearOutbox().
    // Revoke the refresh session on the server: read the stored token and send it
    // in the body of /auth/logout (falling back to the cookie when none is stored),
    // then clear our local copy. Best-effort — the cookie is also cleared by the backend.
    void (async () => {
      try {
        const stored = await loadRefreshToken()
        await new AuthApi(authApiConfig()).authLogoutPost(
          stored ? { refresh_token: stored } : undefined,
        )
      } catch {
        // the session is revoked/expired on the client regardless
      } finally {
        // Local cleanup must never throw out of logout (an IndexedDB failure —
        // e.g. a missing object store — would otherwise surface as an
        // unhandled promise rejection after the user logged out).
        await clearRefreshToken().catch(() => {})
      }
    })()
    setAccessToken(null)
    // The permission cache is per-user: drop the logged-out account's key and
    // the in-memory snapshot so a later login (the same or another account)
    // starts from its real /permissions/me, never from these rights.
    const wasUid = user.value?.id
    if (wasUid != null) localStorage.removeItem(permsKey(wasUid))
    useRbacStore().resetPermissions()
    localStorage.removeItem(USER_KEY)
    user.value = null
    isAuthenticated.value = false
    sessionMode.value = 'online'
    // After an explicit logout, auto-sync does not log in until a manual login
    setLoggedOut()
    // Drop the user-scoped payloads of the logged-out account so a later login
    // (the same or another account) starts from its own server-scoped data —
    // never from the previous session's rows (the GET cache itself is per-user
    // keyed — see offline/cache.ts — so no cache wipe is needed).
    useTimesheetStore().resetUserData()
    useAppStore().resetUserData()
    usePlanningStore().resetUserData()
  }

  /** Fetches fresh user data by id via UsersApi.usersIdGet */
  async function fetchProfile(userId: number): Promise<boolean> {
    if (isOffline.value && user.value) return true
    error.value = null
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userIdGet(userId)
      const body = resp.data
      const errBody = body?.error as { code?: unknown; message?: string } | undefined
      if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
      if (body?.data) {
        user.value = body.data as DtoUserInfo
        localStorage.setItem(USER_KEY, JSON.stringify(user.value))
      }
      return true
    } catch (e: unknown) {
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      return false
    }
  }

  /** Local-first profile: hydrate from the cache; network refresh via fetchProfile */
  async function loadProfile(userId: number): Promise<boolean> {
    if (user.value) return true
    await hydrateFromCache([
      {
        path: apiPath(`/user/${userId}`),
        filled: () => user.value != null,
        apply: (body) => {
          const d = (body as { data?: DtoUserInfo } | undefined)?.data
          if (d) {
            user.value = d
            localStorage.setItem(USER_KEY, JSON.stringify(d))
          }
        },
      },
    ])
    return user.value != null
  }

  // After a page reload with saved tokens, continue proactive refresh
  if (isAuthenticated.value) {
    scheduleProactiveRefresh()
    scheduleWarmup()
  }

  // Adopt fresher sessions (access token + rotated refresh token) published by
  // sibling tabs (cross-tab refresh coordination in ALL environments — the
  // refresh token is shared and rotated once per family).
  let unsubscribeSessionToken: (() => void) | null = null
  unsubscribeSessionToken = subscribeSession(({ access }) => {
    if (isLoggedOut()) return
    if (access) {
      const cur = accessTokenExpiresAt(getAccessToken())
      const next = accessTokenExpiresAt(access)
      if (next != null && (cur == null || next > cur)) setAccessToken(access)
    }
    // The owner persisted the shared refresh token before broadcasting; replaying it here can roll it back.
  })
  onScopeDispose(() => unsubscribeSessionToken?.())

  return {
    user,
    isAuthenticated,
    accessExpired,
    sessionMode,
    loading,
    error,
    login,
    enterOffline,
    changePassword,
    refreshSession,
    waitForSessionRefresh,
    startBackgroundSession,
    stopBackgroundSession,
    fetchProfile,
    loadProfile,
    logout,
  }
})

// === App (projects and resources) ===
export const useAppStore = defineStore('app', () => {
  const projects = ref<DtoProject[]>([])
  const projectsLoading = ref(false)
  const projectsError = ref<string | null>(null)

  /**
   * Local-first: fill the projects list from the cache if empty. Network refresh
   * happens only through the background PULL cycle (refreshProjects).
   */
  async function loadProjects(): Promise<void> {
    if (projects.value.length) return
    await hydrateFromCache([
      {
        // Keep this path identical to the generated client endpoint (projectGet
        // → `/project`, singular). The GET cache key is the full axios URL, and
        // cacheGetFresh/cacheGetByPath match by pathname — a plural here makes
        // offline hydration always miss and kills the warmup PULL TTL for projects.
        path: apiPath('/project'),
        filled: () => projects.value.length > 0,
        apply: (body) => {
          const d = (body as { data?: { items?: DtoProject[] } } | undefined)?.data
          projects.value = d?.items ?? []
        },
      },
    ])
  }

  async function refreshProjects(): Promise<void> {
    // Only users with project.view (backend-enforced) may list projects; for
    // the others the listing is forbidden (403) — we do not send the request
    // at all. The RBAC matrix is authoritative once loaded; the preset is only
    // a cold-start fallback (mirrors useNavigation / warmup).
    const auth = useAuthStore()
    const rbac = useRbacStore()
    const permsReady = rbac.permsLoaded || rbac.myPermissions.length > 0
    const allowed = permsReady
      ? rbac.can('project', 'view')
      : !auth.user?.preset || ['admin', 'dp', 'rp'].includes(auth.user.preset)
    if (!allowed) {
      projects.value = []
      return
    }
    projectsLoading.value = true
    projectsError.value = null
    try {
      const api = new ProjectsApi(apiConfig())
      const resp = await api.projectGet(tablePageSize.value, undefined, 0)
      const data = resp.data?.data
      projects.value = data?.items ?? []
    } catch (e: unknown) {
      projectsError.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      projectsLoading.value = false
    }
  }

  const resources = ref<DtoResourceResponse[]>([])
  const resourcesLoading = ref(false)
  /** Separate flag for "load more": the table must not flash its loading state */
  const resourcesLoadingMore = ref(false)
  /** Server-side total (from the list envelope) — drives the "load more" button */
  const resourcesTotal = ref(0)
  const resourcesError = ref<string | null>(null)

  /** Whether another resources page can be requested */
  const resourcesHasMore = computed(() => resourcesTotal.value > resources.value.length)

  /** Merges a resources page into the current list (dedup by id, fresh wins) — pure */
  function mergeResourceLists(
    current: DtoResourceResponse[],
    items: DtoResourceResponse[],
  ): DtoResourceResponse[] {
    const byId = new Map<number, DtoResourceResponse>()
    for (const r of current) if (r.id != null) byId.set(r.id, r)
    for (const r of items) if (r.id != null) byId.set(r.id, r)
    return [...byId.values()]
  }

  /** Merges a resources page into the current list (dedup by id, fresh wins) */
  function mergeResources(items: DtoResourceResponse[]): void {
    resources.value = mergeResourceLists(resources.value, items)
  }

  /** Whether two resource snapshots are equal field-by-field (same order, same
   *  ids, same visible fields) — keeps the array reference stable on a
   *  background refresh so dependent computeds/views do not re-render. */
  function sameResources(a: DtoResourceResponse[], b: DtoResourceResponse[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i]?.id !== b[i]?.id) return false
      for (const key of Object.keys(a[i] ?? {}) as Array<keyof DtoResourceResponse>) {
        if (a[i][key] !== b[i]?.[key]) return false
      }
    }
    return true
  }

  async function loadResources(): Promise<void> {
    if (resources.value.length) return
    await hydrateFromCache([
      {
        path: apiPath('/resources'),
        filled: () => resources.value.length > 0,
        apply: (body) => {
          const d = (body as { data?: { items?: DtoResourceResponse[]; total?: number } } | undefined)?.data
          resources.value = d?.items ?? []
          resourcesTotal.value = d?.total ?? 0
        },
      },
    ])
  }

  /**
   * Re-reads the first resources page and merges it into the current list.
   *
   * `silent` — a background refresh (the PULL cycle / warmup steps): it must not
   * touch the page's loading and error state. Those flags drive the "Загрузка…"
   * line, and a background cycle that flips them makes the line flash over an
   * already rendered table. Page-entry and post-mutation refreshes stay loud on
   * purpose: while the list is empty they are the only progress indicator the
   * page has (mirrors `refreshEmployees(managerId, silent)`).
   */
  async function refreshResources(silent = false): Promise<void> {
    if (!silent) {
      resourcesLoading.value = true
      resourcesError.value = null
    }
    try {
      const api = new TimesheetResourcesApi(apiConfig())
      const resp = await api.resourcesGet(tablePageSize.value, undefined, 0)
      const data = resp.data?.data
      const items = data?.items ?? []
      // The background PULL must not truncate pages already loaded via
      // "load more": merge the fresh first page into the existing list (dedup
      // by id, fresh page wins, extra pages kept) — the same policy the
      // offline path uses (mergeResources). The array identity is preserved
      // when the merged roster equals the current one, so dependent views do
      // not re-render on every quiet refresh cycle.
      const merged = mergeResourceLists(resources.value, items)
      if (!sameResources(merged, resources.value)) resources.value = merged
      resourcesTotal.value = data?.total ?? 0
    } catch (e: unknown) {
      if (!silent) resourcesError.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      if (!silent) resourcesLoading.value = false
    }
  }

  /**
   * Appends the next resources page ("load more"). Offline the pages cached by
   * earlier online visits are merged instead of a network request: the offline
   * cache fallback in http.ts serves the freshest response of a pathname, which
   * would hand back page 0 for any offset.
   */
  async function loadMoreResources(): Promise<boolean> {
    if (resourcesLoadingMore.value || !resourcesHasMore.value) return true
    resourcesLoadingMore.value = true
    resourcesError.value = null
    try {
      if (isOffline.value) {
        const pages = await cacheGetAllByPath<{ data?: { items?: DtoResourceResponse[]; offset?: number; total?: number } }>(
          apiPath('/resources'),
        )
        let merged = false
        for (const page of pages) {
          const d = page.data?.data
          if (!d?.items?.length) continue
          mergeResources(d.items)
          if (typeof d.total === 'number' && (d.offset ?? 0) > 0) resourcesTotal.value = d.total
          merged = true
        }
        if (!merged) resourcesError.value = t('offline.noCachedData')
        return merged
      }
      const api = new TimesheetResourcesApi(apiConfig())
      const resp = await api.resourcesGet(tablePageSize.value, undefined, resources.value.length)
      const data = resp.data?.data
      mergeResources(data?.items ?? [])
      resourcesTotal.value = data?.total ?? resourcesTotal.value
      return true
    } catch (e: unknown) {
      resourcesError.value = e instanceof Error ? e.message || String(e) : String(e)
      return false
    } finally {
      resourcesLoadingMore.value = false
    }
  }

  async function createResource(payload: DtoCreateResourceRequest): Promise<boolean> {
    resourcesError.value = null
    payload = { ...payload, owner_id: payload.owner_id ?? useAuthStore().user?.id }
    const tempId = nextTempId()
    return runMutation({
      entity: 'resource',
      tempId,
      call: async () => {
        const resp = await new TimesheetResourcesApi(apiConfig()).resourcesPost(payload)
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (data) => {
        if (data) resources.value.push(data)
      },
      optimistic: () => {
        resources.value.push({ id: tempId, ...payload } as unknown as DtoResourceResponse)
      },
      onError: (m) => {
        resourcesError.value = m
      },
    })
  }

  async function updateResource(id: number, patch: DtoUpdateResourceRequest): Promise<boolean> {
    resourcesError.value = null
    const previousOwner = resources.value.find((r) => r.id === id)?.owner_id
    const clearAssignments = () => {
      if (patch.owner_id == null || patch.owner_id === previousOwner) return
      for (const process of usePlanningStore().taskPlanning?.processes ?? []) {
        for (const task of process.tasks ?? []) task.resources = task.resources?.filter((r) => r.id !== id)
      }
    }
    return runMutation({
      entity: 'resource',
      call: async () => {
        const resp = await new TimesheetResourcesApi(apiConfig()).resourcesIdPut(id, patch)
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (updated) => {
        if (!updated) return
        clearAssignments()
        const i = resources.value.findIndex((r) => r.id === id)
        if (i >= 0) resources.value[i] = updated
      },
      optimistic: () => {
        clearAssignments()
        const i = resources.value.findIndex((r) => r.id === id)
        if (i >= 0) resources.value[i] = { ...resources.value[i], ...patch }
      },
      onError: (m) => {
        resourcesError.value = m
      },
    })
  }

  async function deleteResource(id: number): Promise<boolean> {
    resourcesError.value = null
    const remove = () => {
      const i = resources.value.findIndex((r) => r.id === id)
      if (i >= 0) resources.value.splice(i, 1)
    }
    return runMutation({
      entity: 'resource',
      call: () => new TimesheetResourcesApi(apiConfig()).resourcesIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        resourcesError.value = m
      },
    })
  }

  // === Resource users (/resources/{id}/members) ===
  const resourceMembers = ref<Record<number, DtoResourceMemberResponse[]>>({})

  /** Loads the member (user) list of a resource — local-first (cache) */
  async function loadResourceMembers(resourceId: number): Promise<void> {
    if (resourceMembers.value[resourceId] != null) return
    await hydrateFromCache([
      {
        path: apiPath(`/resources/${resourceId}/members`),
        filled: () => resourceMembers.value[resourceId] != null,
        apply: (body) => {
          resourceMembers.value[resourceId] =
            (body as { data?: DtoResourceMemberResponse[] } | undefined)?.data ?? []
        },
      },
    ])
  }

  async function refreshResourceMembers(resourceId: number): Promise<void> {
    try {
      const api = new TimesheetResourcesApi(apiConfig())
      const resp = await api.resourcesIdMembersGet(resourceId)
      resourceMembers.value[resourceId] = resp.data?.data ?? []
    } catch (e: unknown) {
      resourcesError.value = e instanceof Error ? e.message || String(e) : String(e)
    }
  }

  /** Adds a user to a resource (POST members); any user can be a member */
  async function addResourceMember(resourceId: number, userId: number): Promise<boolean> {
    resourcesError.value = null
    const tempId = nextTempId()
    return runMutation({
      entity: 'member',
      tempId,
      call: () => new TimesheetResourcesApi(apiConfig()).resourcesIdMembersPost(resourceId, {
        user_id: userId,
      }),
      apply: async () => {
        await refreshResourceMembers(resourceId)
        await refreshResources()
      },
      optimistic: () => {
        const list = resourceMembers.value[resourceId] ?? []
        const w = useTimesheetStore().employees.find((e) => e.id === userId)
        if (!list.some((m) => m.id === userId)) {
          list.push({
            id: userId,
            name: w?.name ?? `#${userId}`,
            preset: 'worker',
            position: w?.position,
            manager_id: w?.manager_id,
            hire_date: w?.hire_date,
            termination_date: w?.termination_date,
          })
        }
        resourceMembers.value[resourceId] = list
      },
      onError: (m) => {
        resourcesError.value = m
      },
    })
  }

  /** Removes a user from a resource (DELETE members/{userId}) */
  async function removeResourceMember(resourceId: number, userId: number): Promise<boolean> {
    resourcesError.value = null
    const remove = () => {
      const list = resourceMembers.value[resourceId]
      if (!list) return
      resourceMembers.value[resourceId] = list.filter((m) => m.id !== userId)
    }
    return runMutation({
      entity: 'member',
      call: () => new TimesheetResourcesApi(apiConfig()).resourcesIdMembersUserIdDelete(resourceId, userId),
      apply: async () => {
        remove()
        await refreshResources()
      },
      optimistic: remove,
      onError: (m) => {
        resourcesError.value = m
      },
    })
  }

  /** Reverse map "user → their resource" (membership is unique: UNIQUE(user_id)) */
  const resourceByUser = computed<Record<number, DtoResourceResponse>>(() => {
    const map: Record<number, DtoResourceResponse> = {}
    for (const res of resources.value) {
      if (res.id == null) continue
      for (const m of resourceMembers.value[res.id] ?? []) {
        if (m.id != null) map[m.id] = res
      }
    }
    return map
  })

  /**
   * Ensures resources and their members are loaded — for resource badges and the
   * filter on the "Employees" page. With force=true members are reloaded always
   * (so badges reflect the current membership after changes on the "Resources"
   * page), otherwise only the missing ones are loaded.
   */
  async function ensureResourceMembers(force = false) {
    if (!resources.value.length) await loadResources()
    for (const res of resources.value) {
      if (res.id == null) continue
      if (force || resourceMembers.value[res.id] == null) {
        // force — explicit network refresh (badges after edits); otherwise local hydrate
        await (force ? refreshResourceMembers(res.id) : loadResourceMembers(res.id))
      }
    }
  }

  /**
   * Changes an employee's resource: detaches from fromResourceId, attaches to
   * toResourceId (null — employee without a resource). Returns false and puts a
   * message into resourcesError on rejection (e.g. 403 on a foreign resource).
   */
  async function changeEmployeeResource(
    userId: number,
    fromResourceId: number | null,
    toResourceId: number | null,
  ): Promise<boolean> {
    if (fromResourceId === toResourceId) return true
    if (fromResourceId != null) {
      const ok = await removeResourceMember(fromResourceId, userId)
      if (!ok) return false
    }
    if (toResourceId != null) {
      const ok = await addResourceMember(toResourceId, userId)
      if (!ok) return false
    }
    return true
  }

  // === Resource availability calendar (/timesheet/calendar) ===
  // Load window: 180 days back, 360 forward (540 total < the backend's 730-day limit).
  const CALENDAR_BACK_DAYS = 180
  const CALENDAR_FORWARD_DAYS = 360
  const calendar = ref<DtoResourceCalendar[]>([])
  const calendarLoading = ref(false)
  const calendarError = ref<string | null>(null)

  /** Date YYYY-MM-DD n days from the base date (for the calendar load window) */
  function calendarDay(day: Date, offsetDays: number): string {
    const d = new Date(day.getTime() + offsetDays * 86_400_000)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${dd}`
  }

  /** Loads resource availability for the "180 days back / 360 days forward" window (within the backend limit) */
  async function loadCalendar(): Promise<void> {
    if (calendar.value.length) return
    await hydrateFromCache([
      {
        path: apiPath('/timesheet/calendar'),
        filled: () => calendar.value.length > 0,
        apply: (body) => {
          const d = (body as { data?: { resources?: DtoResourceCalendar[] } } | undefined)?.data
          calendar.value = d?.resources ?? []
        },
      },
    ])
  }

  async function refreshCalendar(): Promise<void> {
    const timesheet = useTimesheetStore()
    if (timesheet.busy) return
    const revision = timesheet.periodRevision
    calendarLoading.value = true
    calendarError.value = null
    try {
      const today = new Date()
      const api = new TimesheetCalendarApi(apiConfig())
      const resp = await api.timesheetCalendarGet(
        calendarDay(today, -CALENDAR_BACK_DAYS),
        calendarDay(today, CALENDAR_FORWARD_DAYS),
      )
      if (!timesheet.busy && revision === timesheet.periodRevision) calendar.value = resp.data?.data?.resources ?? []
    } catch (e: unknown) {
      calendarError.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      calendarLoading.value = false
    }
  }

  // === Resource member absences (/resources/{id}/absence) for the UsageCell tooltip ===
  const absenceByResource = ref<Record<number, DtoResourceAbsenceResponse[]>>({})

  /** Loads absences (unavailable states) of a resource's members for a window */
  async function loadResourceAbsence(resourceId: number, from: string, to: string) {
    const timesheet = useTimesheetStore()
    if (timesheet.busy) return
    const revision = timesheet.periodRevision
    try {
      const api = new TimesheetResourcesApi(apiConfig())
      const resp = await api.resourcesIdAbsenceGet(resourceId, from, to)
      if (timesheet.busy || revision !== timesheet.periodRevision) return
      absenceByResource.value = { ...absenceByResource.value, [resourceId]: resp.data?.data ?? [] }
    } catch {
      // Skip: the tooltip will simply not show absent members on this resource.
    }
  }

  const users = ref<DtoUserInfo[]>([])
  const usersLoading = ref(false)
  const usersError = ref<string | null>(null)

  /** Current user's direct subordinates (/users scope): "own employees".
   *  For vp — only users with manager_id = current user; for admin — everyone.
   *  Used as the candidate pool for task "assignees". */
  const myStaff = ref<DtoUserResponse[]>([])
  const myStaffLoading = ref(false)

  async function loadUsers(): Promise<void> {
    if (users.value.length) return
    await hydrateFromCache([
      {
        path: apiPath('/user/all'),
        filled: () => users.value.length > 0,
        apply: (body) => {
          const d = (body as { data?: DtoUserInfo[] } | undefined)?.data
          users.value = d ?? []
        },
      },
    ])
    // A cold catalog must trigger the background PULL instead of hiding people indefinitely.
    if (!users.value.length) scheduleWarmup()
  }

  async function refreshUsers(): Promise<void> {
    usersLoading.value = true
    usersError.value = null
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userAllGet()
      users.value = resp.data?.data ?? []
    } catch (e: unknown) {
      usersError.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      usersLoading.value = false
    }
  }

  /** Loads "own staff" (scoped /users without a role filter). */
  async function loadMyStaff(): Promise<void> {
    if (myStaff.value.length) return
    await hydrateFromCache([
      {
        path: apiPath('/user'),
        filled: () => myStaff.value.length > 0,
        keyPredicate: (key) => /\blimit=500\b/.test(key),
        apply: (body) => {
          const d = (body as { data?: { items?: DtoUserResponse[] } } | undefined)?.data
          myStaff.value = d?.items ?? []
        },
      },
    ])
  }

  async function refreshMyStaff(): Promise<void> {
    myStaffLoading.value = true
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userGet(500, undefined, undefined, undefined, undefined, 0)
      myStaff.value = resp.data?.data?.items ?? []
    } catch {
      // Not critical: the candidate pool stays as is.
    } finally {
      myStaffLoading.value = false
    }
  }

  // === Admin: users (all roles, with the password hash) ===
  const adminUsers = ref<DtoAdminUserResponse[]>([])
  const adminUsersLoading = ref(false)
  const adminUsersError = ref<string | null>(null)

  /** Full user list for the admin page (without password hashes) */
  async function loadAdminUsers(): Promise<void> {
    await refreshAdminUsers('')
  }

  /**
   * Reloads the admin user list applying a server-side search ('' = all users).
   * The search is a case-insensitive substring of the full name/login
   * (max 128 chars; LIKE escaping is done by the backend) and always starts
   * from the first page (offset 0).
   */
  async function refreshAdminUsers(search: string): Promise<void> {
    adminUsersLoading.value = true
    adminUsersError.value = null
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userAccountsGet(500, undefined, undefined, false, search || undefined, 0)
      adminUsers.value = resp.data?.data?.items ?? []
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
    } finally {
      adminUsersLoading.value = false
    }
  }

  /** Creates a user; returns the generated password (if any) */
  async function createUser(payload: DtoCreateUserRequest): Promise<DtoCreateUserResult | null> {
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userPost(payload)
      await loadAdminUsers()
      // The new account must appear in the roster/name catalog immediately
      // (coalesced silent refresh of the user domains).
      if (!isOffline.value) scheduleDomainRefresh(['user'])
      return resp.data?.data ?? null
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return null
    }
  }

  /** Resets a user's password (admin-only); returns the generated password (shown once) or null. */
  async function resetPassword(id: number): Promise<string | null> {
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userIdResetPasswordPost(id)
      // The backend now returns the generated password once in the body.
      return resp.data?.data?.password ?? null
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return null
    }
  }

  /** Updates a user (role/manager/profile) */
  async function updateUser(id: number, patch: DtoUpdateUserRequest): Promise<boolean> {
    try {
      const api = new UsersApi(apiConfig())
      await api.userIdPut(id, patch)
      await loadAdminUsers()
      if (!isOffline.value) scheduleDomainRefresh(['user'])
      return true
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return false
    }
  }

  /** Sets/unsets a user's manager (manager_id: null — no manager) */
  async function updateManager(id: number, managerId: number | null): Promise<boolean> {
    try {
      const api = new UsersApi(apiConfig())
      await api.userIdManagerPut(id, { manager_id: managerId ?? undefined })
      await loadAdminUsers()
      // The structure change must refresh the "Руководитель" column on the
      // Employees page and the roster immediately.
      if (!isOffline.value) scheduleDomainRefresh(['user'])
      return true
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return false
    }
  }

  /** Deletes (soft) a user — user lifecycle lives in the admin users section */
  async function deleteUser(id: number): Promise<boolean> {
    try {
      const api = new UsersApi(apiConfig())
      await api.userIdDelete(id)
      await loadAdminUsers()
      // The deleted account must leave the roster/name catalog immediately.
      if (!isOffline.value) scheduleDomainRefresh(['user'])
      return true
    } catch (e: unknown) {
      adminUsersError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return false
    }
  }

  // === Admin: auto-creation of projects ===
  const autoCreateConfig = ref<DtoAutoCreateConfig | null>(null)
  const autoCreateLoading = ref(false)
  const autoCreateError = ref<string | null>(null)

  /** Loads the auto-create configuration */
  async function loadAutoCreateConfig() {
    autoCreateLoading.value = true
    autoCreateError.value = null
    try {
      const api = new AutoCreateApi(apiConfig())
      const resp = await api.autoCreateConfigGet()
      autoCreateConfig.value = resp.data?.data ?? null
    } catch (e: unknown) {
      autoCreateError.value = apiErrorMessage(e as { message?: string; code?: unknown })
    } finally {
      autoCreateLoading.value = false
    }
  }

  /** Saves the auto-create configuration (full replacement) */
  async function saveAutoCreateConfig(cfg: DtoAutoCreateConfig): Promise<boolean> {
    try {
      const api = new AutoCreateApi(apiConfig())
      await api.autoCreateConfigPut(cfg)
      autoCreateConfig.value = cfg
      return true
    } catch (e: unknown) {
      autoCreateError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return false
    }
  }

  /** Clears the user-scoped payloads on logout/account switch (the GET cache
   *  itself is per-user keyed — see offline/cache.ts). */
  function resetUserData(): void {
    users.value = []
    resources.value = []
    resourceMembers.value = {}
    absenceByResource.value = {}
  }

  return {
    projects,
    projectsLoading,
    projectsError,
    resources,
    resourcesLoading,
    resourcesLoadingMore,
    resourcesTotal,
    resourcesHasMore,
    resourcesError,
    users,
    usersLoading,
    usersError,
    calendar,
    calendarLoading,
    calendarError,
    loadProjects,
    refreshProjects,
    loadResources,
    loadMoreResources,
    refreshResources,
    loadCalendar,
    refreshCalendar,
    absenceByResource,
    loadResourceAbsence,
    loadUsers,
    refreshUsers,
    myStaff,
    myStaffLoading,
    loadMyStaff,
    refreshMyStaff,
    adminUsers,
    adminUsersLoading,
    adminUsersError,
    loadAdminUsers,
    refreshAdminUsers,
    createUser,
    resetPassword,
    updateUser,
    updateManager,
    deleteUser,
    autoCreateConfig,
    autoCreateLoading,
    autoCreateError,
    loadAutoCreateConfig,
    saveAutoCreateConfig,
    createResource,
    updateResource,
    deleteResource,
    resourceMembers,
    loadResourceMembers,
    refreshResourceMembers,
    addResourceMember,
    removeResourceMember,
    resourceByUser,
    ensureResourceMembers,
    changeEmployeeResource,
    resetUserData,
  }
})

// === Timesheet (employee states, page for vp/admin) ===
export const useTimesheetStore = defineStore('timesheet', () => {
  // States load window: by default "180 days back / 360 days forward"; with
  // infinite scroll the timeline is extended via ensureRange (loading new ranges).
  const WINDOW_BACK_DAYS = 180
  const WINDOW_FORWARD_DAYS = 360

  const employees = ref<DtoUserResponse[]>([])
  const employeesTotal = ref(0)
  /** Separate flag for "load more": the roster must not flash its loading state */
  const employeesLoadingMore = ref(false)
  /** User who loaded the current roster (null — none yet); the roster is
   *  server-scoped, so an account switch must never reuse another user's rows. */
  const employeesLoadedFor = ref<number | null>(null)
  const states = ref<DtoStateResponse[]>([])
  const periodsByEmployee = ref<Record<number, DtoUserStateResponse[]>>({})
  const periodRevision = ref(0)
  const windowStart = ref('')
  const windowEnd = ref('')
  const loading = ref(false)
  const busy = ref(false)
  const error = ref<string | null>(null)

  /** Employees (users visible to the current user), sorted by full name */
  const employeesWithTitles = computed<DtoUserResponse[]>(() =>
    [...employees.value].sort(
      (a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', 'ru') ||
        (a.position || '').localeCompare(b.position || '', 'ru'),
    ),
  )

  /**
   * Timesheet rows: the employees visible to the current user (direct subordinates;
   * admin — everyone). The current user is intentionally not a row — the roster
   * mirrors the "Employees" page.
   */
  const timesheetRows = computed<DtoUserResponse[]>(() => employeesWithTitles.value)

  function todayISO(): string {
    const d = new Date()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${d.getFullYear()}-${m}-${dd}`
  }

  function setError(e: unknown) {
    error.value = e instanceof Error ? e.message || String(e) : String(e)
  }

  /** Local-first: hydrate each employee's states from the cache (freshest window) */
  async function fetchPeriodsLocal(): Promise<void> {
    const targets = timesheetRows.value.map((emp) => ({
      path: apiPath(`/user/${emp.id ?? 0}/days`),
      filled: () => periodsByEmployee.value[emp.id ?? 0] != null,
      apply: (body: unknown) => {
        const list = (body as { data?: DtoUserStateResponse[] } | undefined)?.data ?? []
        periodsByEmployee.value[emp.id ?? 0] = [...list].sort((a, b) =>
          (a.start_date ?? '').localeCompare(b.start_date ?? ''),
        )
      },
    }))
    await hydrateFromCache(targets)
  }

  /** Merges a fresh [start, end] window response for one employee into the cache */
  function mergeWindowPeriods(id: number, list: DtoUserStateResponse[], start: string, end: string): void {
    if (busy.value) return
    const existing = periodsByEmployee.value[id] ?? []
    const merged = mergePeriodWindow(existing, list, start, end)
    if (merged !== existing) periodsByEmployee.value[id] = merged
  }

  /**
   * Fallback: the pre-batch per-employee fetch (one GET /user/{id}/days per
   * visible row), used when the batch endpoint is unavailable (e.g. an older
   * backend without GET /user/days). The timesheet must keep working in that
   * case — the batch is only an optimization. Lenient: a failed row keeps its
   * previous cached data; returns false only when at least one row failed.
   */
  async function refreshPeriodsOneByOne(start: string, end: string): Promise<boolean> {
    const revision = periodRevision.value
    const api = new UsersApi(apiConfig())
    let failed: unknown = null
    const results = await Promise.all(
      timesheetRows.value.map((emp) =>
        api
          .userIdDaysGet(emp.id ?? 0, start, end)
          .then((r) => ({ id: emp.id, list: r.data?.data ?? [] }))
          .catch((e: unknown) => {
            failed = failed ?? e
            return { id: emp.id, list: null }
          }),
      ),
    )
    if (revision !== periodRevision.value) return false
    for (const { id, list } of results) {
      if (id == null || list == null) continue
      mergeWindowPeriods(id, list, start, end)
    }
    return failed == null
  }

  /**
   * Network refresh (PULL) for the whole timesheet in a single batch request.
   * Replaces the previous per-employee N+1 fan-out: GET /user/days returns one
   * entry per requested id (empty `days` when the worker has none).
   * The [start, end] window stays authoritative for every employee in the batch.
   * Ids are sent in chunks of BATCH_IDS_MAX (the backend limit ≤200); each
   * chunk is still one request — no per-employee fan-out — and failures are
   * reported once for the whole page. If the batch endpoint is not available
   * (unexpected payload shape or a request error), falls back to the
   * per-employee path so the timesheet renders even against an older backend.
   */
  async function refreshPeriodsBatch(start: string, end: string): Promise<boolean> {
    if (busy.value) return false
    const revision = periodRevision.value
    const ids = timesheetRows.value
      .map((e) => e.id)
      .filter((id): id is number => id != null)
    if (ids.length === 0) return true
    const api = new UsersApi(apiConfig())
    try {
      const chunks: number[][] = []
      for (let i = 0; i < ids.length; i += BATCH_IDS_MAX) chunks.push(ids.slice(i, i + BATCH_IDS_MAX))
      const responses = await Promise.all(
        chunks.map((chunk) => api.userDaysGet(chunk.join(','), start, end)),
      )
      if (revision !== periodRevision.value) return false
      for (const resp of responses) {
        const entries = resp.data?.data
        // Shape guard: an older backend (or a proxy) answering the URL with a
        // non-batch payload must not be merged as if it were one.
        if (!Array.isArray(entries)) throw new Error('batch days response: unexpected payload shape')
        for (const entry of entries) {
          if (entry.user_id == null) continue
          mergeWindowPeriods(entry.user_id, entry.days ?? [], start, end)
        }
      }
      // Unsync guard: if the backend omitted some requested ids, their current
      // cached data is intentionally kept untouched instead of being wiped.
      return true
    } catch (e: unknown) {
      // The batch endpoint may be missing on an older backend — fall back to
      // the per-employee path; surface an error only when the fallback fails too.
      if (revision !== periodRevision.value || busy.value) return false
      const ok = await refreshPeriodsOneByOne(start, end)
      if (!ok) setError(e)
      else console.warn('[timesheet] batch days unavailable, fell back to per-employee:', e instanceof Error ? e.message : e)
      return ok
    }
  }

  /** Network refresh (PULL) entry point: keeps the (start, end) signature used by warmup/sync/ensureRange */
  async function refreshPeriods(start: string, end: string): Promise<boolean> {
    return refreshPeriodsBatch(start, end)
  }

  /** An employee's period covering a day (binary search over the sorted periods) */
  function periodFor(employeeId: number, iso: string): DtoUserStateResponse | undefined {
    const list = periodsByEmployee.value[employeeId] ?? []
    let lo = 0
    let hi = list.length - 1
    let ans = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if ((list[mid].start_date ?? '') <= iso) {
        ans = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    const p = list[ans]
    return p && p.end_date != null && p.end_date >= iso ? p : undefined
  }

  /** Response shape of the paginated employees list (`/user` with limit/offset) */
  interface EmployeePage {
    data?: { items?: DtoUserResponse[]; limit?: number; offset?: number; total?: number }
  }

  /** Merges an employees page into the current list (dedup by id, fresh wins) — pure */
  function mergeEmployeeLists(current: DtoUserResponse[], items: DtoUserResponse[]): DtoUserResponse[] {
    const byId = new Map<number, DtoUserResponse>()
    for (const e of current) if (e.id != null) byId.set(e.id, e)
    for (const e of items) if (e.id != null) byId.set(e.id, e)
    return [...byId.values()]
  }

  /** Merges an employees page into the current list (dedup by id, fresh wins) */
  function mergeEmployees(items: DtoUserResponse[]): void {
    employees.value = mergeEmployeeLists(employees.value, items)
  }

  /**
   * Whether two roster snapshots are equal field-by-field (same order, same ids,
   * same visible fields). Used to keep the `employees` array reference stable on
   * a background refresh so dependent computeds and the grid do not re-render.
   */
  function sameEmployees(a: DtoUserResponse[], b: DtoUserResponse[]): boolean {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (a[i]?.id !== b[i]?.id) return false
      // Shallow compare: the roster DTO is flat (name/position/manager/…), so a
      // field-by-field check is enough to notice a real change.
      for (const key of Object.keys(a[i] ?? {}) as Array<keyof DtoUserResponse>) {
        if (a[i][key] !== b[i]?.[key]) return false
      }
    }
    return true
  }

  /** Local-first: hydrate the employee list (scoped by the backend) from the cache */
  async function loadEmployeesList(): Promise<void> {
    // The roster is scoped to the authenticated user: reuse it only for the
    // same account (an account switch must never surface another user's rows).
    const uid = useAuthStore().user?.id ?? null
    if (employeesLoadedFor.value === uid && employees.value.length) return
    employeesLoadedFor.value = uid
    await hydrateFromCache([
      {
        path: apiPath('/user'),
        filled: () => employees.value.length > 0,
        // No role filter — the roster is scoped server-side (admin: all, vp: own
        // subordinates). The employees query is the only /user call with limit=50.
        keyPredicate: (key) => /\blimit=50\b/.test(key),
        apply: (body) => {
          const d = (body as { data?: { items?: DtoUserResponse[]; total?: number } } | undefined)?.data
          employees.value = d?.items ?? []
          employeesTotal.value = d?.total ?? 0
        },
      },
    ])
  }

  async function refreshEmployees(managerId?: number, silent = false): Promise<void> {
    if (!silent) {
      loading.value = true
      error.value = null
    }
    try {
      const api = new UsersApi(apiConfig())
      const resp = await api.userGet(tablePageSize.value, undefined, managerId ?? undefined, undefined, undefined, 0)
      const data = resp.data?.data
      // Sorting is added by the computed employeesWithTitles.
      //
      // The background PULL must not silently drop pages the user already
      // opened via "Показать ещё" (page size from the UI setting): instead of wholesale
      // replacing the array with page 0, merge the fresh first page into the
      // existing list — dedup by id, fresh page wins, already-loaded extra
      // pages are kept (the same identity-preserving merge the offline path
      // uses). The array reference stays stable when the merged roster equals
      // the current one: it feeds timesheetRows → the whole grid, and
      // replacing an equal-but-new array re-renders every row and flickers the
      // "Табель" page on each background refresh.
      const merged = mergeEmployeeLists(employees.value, data?.items ?? [])
      if (!sameEmployees(merged, employees.value)) employees.value = merged
      employeesTotal.value = data?.total ?? 0
    } catch (e: unknown) {
      if (!silent) setError(e)
    } finally {
      if (!silent) loading.value = false
    }
  }

  /** Whether another employees page can be requested */
  const employeesHasMore = computed(() => employeesTotal.value > employees.value.length)

  /**
   * Appends the next employees page ("load more"). The list is scoped
   * server-side (admin: everyone, vp: own subordinates), so paging is a plain
   * offset request. Offline the pages cached by earlier online visits are
   * merged instead of a network call — the offline cache fallback in http.ts
   * answers by pathname with the freshest page and would ignore the offset.
   * Rows without an id cannot be deduplicated and are dropped.
   */
  async function loadMoreEmployees(): Promise<boolean> {
    if (employeesLoadingMore.value || !employeesHasMore.value) return true
    employeesLoadingMore.value = true
    error.value = null
    try {
      if (isOffline.value) {
        const pages = await cacheGetAllByPath<EmployeePage>(
          apiPath('/user'),
          (key) => /\blimit=50\b/.test(key),
        )
        let merged = false
        for (const page of pages) {
          const d = page.data?.data
          if (!d?.items?.length) continue
          mergeEmployees(d.items)
          if (typeof d.total === 'number' && (d.offset ?? 0) > 0) employeesTotal.value = d.total
          merged = true
        }
        if (!merged) error.value = t('offline.noCachedData')
        return merged
      }
      const api = new UsersApi(apiConfig())
      const resp = await api.userGet(tablePageSize.value, undefined, undefined, undefined, undefined, employees.value.length)
      const data = resp.data?.data
      mergeEmployees(data?.items ?? [])
      employeesTotal.value = data?.total ?? employeesTotal.value
      return true
    } catch (e: unknown) {
      setError(e)
      return false
    } finally {
      employeesLoadingMore.value = false
    }
  }

  /** Loads employees and initializes the states window (for the timesheet).
   *  Local-first — the cache is filled by the background PULL cycle. */
  async function loadEmployees(): Promise<void> {
    if (!employees.value.length) await loadEmployeesList()
    await loadInitialWindow()
  }

  /** Loads the states reference — local-first (cache) */
  async function loadStates(): Promise<void> {
    if (states.value.length) return
    await hydrateFromCache([
      {
        path: apiPath('/timesheet/states'),
        filled: () => states.value.length > 0,
        apply: (body) => {
          states.value = (body as { data?: DtoStateResponse[] } | undefined)?.data ?? []
        },
      },
    ])
  }

  async function refreshStates(): Promise<void> {
    try {
      const api = new TimesheetStatesApi(apiConfig())
      const resp = await api.timesheetStatesGet()
      states.value = resp.data?.data ?? []
    } catch (e: unknown) {
      setError(e)
    }
  }

  /** Fields of the create/update status request */
  interface StatePayload {
    code: string
    name: string
    is_available: boolean
    /** Custom state color (hex); empty/absent — palette fallback */
    color?: string
  }

  /** Creates a status and updates the reference */
  async function createState(payload: StatePayload): Promise<boolean> {
    busy.value = true
    error.value = null
    const tempId = nextTempId()
    try {
      return await runMutation({
        entity: 'state',
        tempId,
        call: () => new TimesheetStatesApi(apiConfig()).timesheetStatesPost(payload),
        apply: async () => {
          await refreshStates()
        },
        optimistic: () => {
          states.value.push({ id: tempId, ...payload } as unknown as DtoStateResponse)
        },
        onError: (m) => {
          error.value = m
        },
      })
    } finally {
      busy.value = false
    }
  }

  /** Updates a status and refreshes the reference */
  async function updateState(id: number, payload: StatePayload): Promise<boolean> {
    busy.value = true
    error.value = null
    try {
      return await runMutation({
        entity: 'state',
        call: () => new TimesheetStatesApi(apiConfig()).timesheetStatesIdPut(id, payload),
        apply: async () => {
          await refreshStates()
        },
        optimistic: () => {
          const i = states.value.findIndex((s) => s.id === id)
          if (i >= 0) states.value[i] = { ...states.value[i], ...payload }
        },
        onError: (m) => {
          error.value = m
        },
      })
    } finally {
      busy.value = false
    }
  }

  /** Deletes a status (deleting an in-use status may be rejected by the DB) */
  async function deleteState(id: number): Promise<boolean> {
    busy.value = true
    error.value = null
    const remove = () => {
      const i = states.value.findIndex((s) => s.id === id)
      if (i >= 0) states.value.splice(i, 1)
    }
    try {
      return await runMutation({
        entity: 'state',
        call: () => new TimesheetStatesApi(apiConfig()).timesheetStatesIdDelete(id),
        apply: async () => {
          await refreshStates()
        },
        optimistic: remove,
        onError: (m) => {
          error.value = m
        },
      })
    } finally {
      busy.value = false
    }
  }

  /** Initializes the "180 back / 360 forward" window: local hydrate from the cache */
  async function loadInitialWindow(): Promise<void> {
    windowStart.value = shiftDate(todayISO(), -WINDOW_BACK_DAYS)
    windowEnd.value = shiftDate(todayISO(), WINDOW_FORWARD_DAYS)
    await fetchPeriodsLocal()
  }

  /** Extends the loaded window to cover [start, end] and loads only the new ranges (user-initiated PULL) */
  async function ensureRange(startISO: string, endISO: string) {
    if (startISO < windowStart.value) {
      const from = startISO
      const to = shiftDate(windowStart.value, -1)
      // Fetch first, commit the widened window only on success: advancing the
      // window before the network round-trip would claim coverage for a range
      // whose periods never loaded (a failed fetch leaves a silently data-less
      // band until the next load).
      const ok = await refreshPeriods(from, to)
      if (ok) windowStart.value = startISO
    }
    if (endISO > windowEnd.value) {
      const from = shiftDate(windowEnd.value, 1)
      const to = endISO
      const ok = await refreshPeriods(from, to)
      if (ok) windowEnd.value = endISO
    }
  }

  /** Keep the timesheet and capacity curve in the same optimistic transaction. */
  async function changeRange(
    employeeId: number,
    startDate: string,
    endDate: string,
    stateId: number | undefined,
    mode: 'put' | 'delete',
  ): Promise<boolean> {
    if (busy.value) return false
    busy.value = true
    error.value = null
    periodRevision.value++
    const app = useAppStore()
    const before = periodsByEmployee.value[employeeId] ?? []
    const state = states.value.find((s) => s.id === stateId)
    const after = applyRangeSplit(before, mode, startDate, endDate, mode === 'delete' ? stateId : undefined, mode === 'put' ? {
      id: nextTempId(), state_id: stateId!, state_code: state?.code,
      state_name: state?.name, is_available: state?.is_available,
    } : undefined)
    const resource = app.resourceByUser[employeeId]
    const previousAbsences = resource?.id != null ? app.absenceByResource[resource.id] : undefined
    const updateCalendar = (from: DtoUserStateResponse[], to: DtoUserStateResponse[]) => {
      if (resource?.id != null) {
        app.calendar = updatePeriodAvailability(app.calendar, resource.id, from, to, startDate, endDate)
        app.absenceByResource[resource.id] = replaceEmployeeAbsences(
          previousAbsences ?? [], to, employeeId, employees.value.find((e) => e.id === employeeId)?.name,
        )
      }
    }
    periodsByEmployee.value[employeeId] = after
    updateCalendar(before, after)
    let ok = false
    try {
      ok = await runMutation({
        entity: 'period',
        call: () => mode === 'put'
          ? new UsersApi(apiConfig()).userIdDaysPut(employeeId, { state_id: stateId, start_date: startDate, end_date: endDate })
          : new UsersApi(apiConfig()).userIdDaysDelete(employeeId, startDate, endDate, stateId),
        apply: () => {},
        optimistic: () => {},
        onError: (message) => {
          error.value = message
          periodsByEmployee.value[employeeId] = before
          updateCalendar(after, before)
          if (resource?.id != null) {
            if (previousAbsences) app.absenceByResource[resource.id] = previousAbsences
            else delete app.absenceByResource[resource.id]
          }
        },
      })
    } finally {
      busy.value = false
      periodRevision.value++
    }
    if (ok && !isOffline.value) {
      await Promise.all([refreshPeriods(windowStart.value || startDate, windowEnd.value || endDate), app.refreshCalendar()])
    }
    return ok
  }

  /** PUT replaces overlapping states while retaining their outside tails. */
  async function assignRange(employeeId: number, stateId: number, startDate: string, endDate: string): Promise<boolean> {
    return changeRange(employeeId, startDate, endDate, stateId, 'put')
  }

  async function clearRange(employeeId: number, startDate: string, endDate: string, stateId?: number): Promise<boolean> {
    return changeRange(employeeId, startDate, endDate, stateId, 'delete')
  }

  /** Clears the user-scoped payloads on logout/account switch. The GET cache
   *  itself is per-user keyed (offline/cache.ts), so no cache wipe is needed —
   *  only the in-memory state must not leak across accounts. */
  function resetUserData(): void {
    periodRevision.value++
    employees.value = []
    employeesTotal.value = 0
    employeesLoadedFor.value = null
    periodsByEmployee.value = {}
    windowStart.value = ''
    windowEnd.value = ''
  }

  return {
    employees,
    employeesWithTitles,
    timesheetRows,
    employeesTotal,
    employeesLoadingMore,
    employeesHasMore,
    states,
    periodsByEmployee,
    periodRevision,
    windowStart,
    windowEnd,
    loading,
    busy,
    error,
    loadEmployees,
    refreshEmployees,
    loadMoreEmployees,
    loadStates,
    refreshStates,
    refreshPeriods,
    createState,
    updateState,
    deleteState,
    ensureRange,
    periodFor,
    assignRange,
    clearRange,
    resetUserData,
  }
})

// === Planning (data from /planning/* for the three charts) ===
export const usePlanningStore = defineStore('planning', () => {
  const taskData = (hasInjectionContext() ? inject(taskDataKey, null) : null) ?? createLegacyTaskData(apiConfig)
  const taskReads = createReadGuard()
  let taskContext = 0
  const projectPlanning = ref<DtoProjectPlanning | null>(null)
  const processPlanning = ref<DtoProcessPlanning | null>(null)
  const taskPlanning = ref<DtoTaskPlanning | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  // === Task comments (discussion threads) ===
  // Cache per task; offline serves the last loaded list (online-only).
  const commentsByTask = ref<Record<number, DtoCommentResponse[]>>({})
  const commentsLoading = ref(false)
  const commentsError = ref<string | null>(null)
  let foregroundLoads = 0

  /** Common planning load path: silent mode leaves loading/error untouched,
   *  so a background reload after a mutation does not clear a visible error and does not show a spinner. */
  async function runLoad(silent: boolean, load: () => Promise<unknown>) {
    if (!silent) {
      foregroundLoads++
      loading.value = true
      error.value = null
    }
    try {
      await load()
    } catch (e: unknown) {
      if (!silent) error.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      if (!silent) loading.value = --foregroundLoads > 0
    }
  }

  /** Local-first: hydrate a planning payload from the cache */
  function hydratePlanning<T>(
    get: () => T | null | undefined,
    set: (v: T | null) => void,
    path: string,
  ): Promise<void> {
    return hydrateFromCache([
      {
        path,
        filled: () => get() != null,
        apply: (body) => {
          set((((body as { data?: unknown } | undefined)?.data ?? null) as T | null) ?? null)
        },
      },
    ])
  }

  async function loadProjectPlanning(): Promise<void> {
    await hydratePlanning(
      () => projectPlanning.value,
      (v) => {
        projectPlanning.value = v
      },
      apiPath('/planning/projects'),
    )
  }

  async function loadProcessPlanning(): Promise<void> {
    await hydratePlanning(
      () => processPlanning.value,
      (v) => {
        processPlanning.value = v
      },
      apiPath('/planning/processes'),
    )
  }

  async function loadTaskPlanning(): Promise<void> {
    if (taskPlanning.value != null) return
    const context = taskContext
    const result = await taskData.readPlanning({ source: 'snapshot' })
    if (context !== taskContext || taskPlanning.value != null) return
    if (result.status === 'ok') taskPlanning.value = result.data
    else if (result.status === 'failed') throw new Error(result.error.message)
  }

  async function refreshProjectPlanning(silent = false): Promise<void> {
    await runLoad(silent, async () => {
      const stamp = readStamp()
      const resp = await new PlanningApi(apiConfig()).planningProjectsGet()
      if (!mayApplyRead(stamp)) return
      if (pendingRefs.value.size === 0) projectPlanning.value = resp.data?.data ?? null
      // A durable queue must preserve edits without blocking the first snapshot.
      else if (projectPlanning.value == null) await loadProjectPlanning()
    })
  }

  async function refreshProcessPlanning(silent = false): Promise<void> {
    await runLoad(silent, async () => {
      const stamp = readStamp()
      const resp = await new PlanningApi(apiConfig()).planningProcessesGet()
      if (!mayApplyRead(stamp)) return
      if (pendingRefs.value.size === 0) processPlanning.value = resp.data?.data ?? null
      // A durable queue must preserve edits without blocking the first snapshot.
      else if (processPlanning.value == null) await loadProcessPlanning()
    })
  }

  async function refreshTaskPlanning(silent = false): Promise<void> {
    await runLoad(silent, async () => {
      const request = taskReads.begin()
      const stamp = readStamp()
      const result = await taskData.readPlanning({ source: 'refresh' })
      if (!request.isCurrent() || !mayApplyRead(stamp)) return
      if (result.status === 'failed') throw new Error(result.error.message)
      if (result.status === 'cancelled') return
      if (pendingRefs.value.size === 0) taskPlanning.value = result.status === 'ok' ? result.data : null
      // A durable queue must preserve edits without blocking the first snapshot.
      else if (taskPlanning.value == null) await loadTaskPlanning()
    })
  }

  /** Saves the new bar dates, then silently reloads the data (no spinner).
   *  On a save error it shows a message and falls back to the server data. */
  function findProjectRow(id: number): DtoProject | undefined {
    return projectPlanning.value?.projects?.find((p: DtoProject) => p.id === id)
  }

  function findProcessRow(id: number): DtoProcess | undefined {
    for (const p of processPlanning.value?.projects ?? []) {
      const pr = (p.processes ?? []).find((x: DtoProcess) => x.id === id)
      if (pr) return pr
    }
    return undefined
  }

  /** Finds a task (top-level or subtask) anywhere in the planning data. */
  function findTaskRow(id: number): DtoDetailedTask | undefined {
    return findPlanningTask(taskPlanning.value?.processes ?? [], id)
  }

  /** Locates the object holding a subtask list (a top-level task with subtasks). */
  function findSubtaskOwner(id: number): DtoDetailedTask | undefined {
    for (const p of taskPlanning.value?.processes ?? []) {
      const t = (p.tasks ?? []).find((x: DtoDetailedTask) =>
        (x.subtasks ?? []).some((s: DtoDetailedTask) => s.id === id),
      )
      if (t) return t
    }
    return undefined
  }

  function findMilestoneRow(id: number): DtoMilestone | undefined {
    for (const p of taskPlanning.value?.processes ?? []) {
      const m = (p.milestones ?? []).find((x: DtoMilestone) => x.id === id)
      if (m) return m
    }
    return undefined
  }

  /**
   * Local-first patch of a dragged bar/marker row: the diagram must show the
   * dropped dates AT ONCE, because the drag preview is cleared on pointer-up
   * while the PUT and the following re-read still lie ahead — without the patch
   * the bar snaps back to the old span and only then jumps to the new one. The
   * task cascade already works this way (persistDatePatches); the process,
   * project and milestone paths join it here. A move the server rejects is
   * rolled back by the silent reload in onError (the server dates win).
   *
   * `undefined` values are skipped: apply() feeds this with a server payload,
   * where an absent field must not overwrite a known value with undefined.
   */
  function patchRow<T extends object>(row: T | null | undefined, patch: Partial<T>): void {
    if (!row) return
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (row as Record<string, unknown>)[key] = value
    }
  }

  async function mutateTask(
    id: number,
    patch: DtoUpdateTaskRequest,
    apply: (dto: DtoTaskResponse | null) => void,
    optimistic: () => void,
    onError: (message: string) => void,
  ): Promise<boolean> {
    const context = taskContext
    const finish = beginMutation()
    try {
      const result = await taskData.update(id, patch)
      if (context !== taskContext) return false
      if (result.status === 'confirmed') {
        apply(result.data)
        return true
      }
      if (result.status === 'queued') {
        optimistic()
        return true
      }
      onError(result.error.message)
      return false
    } finally {
      finish()
    }
  }

  /** Bar date shift: local edit first (see patchRow), then the PUT. */
  async function updateTaskDates(id: number, start_date: string, end_date: string): Promise<boolean> {
    const row = findTaskRow(id)
    const previous = { start_date: row?.start_date, end_date: row?.end_date }
    const applyLocally = () => patchRow(findTaskRow(id), { start_date, end_date })
    applyLocally()
    return mutateTask(id, { start_date, end_date },
      (dto) => patchRow(findTaskRow(id), { start_date: dto?.start_date, end_date: dto?.end_date }),
      applyLocally,
      (m) => {
        error.value = m
        const current = findTaskRow(id)
        if (current?.start_date === start_date && current?.end_date === end_date) patchRow(current, previous)
        void refreshTaskPlanning(true)
      },
    )
  }

  // === Dependency constraints (scheduling links between top-level tasks) ===

  /** The process whose task list contains the given task (top-level or subtask). */
  function findProcessOfTask(id: number): DtoDetailedProcess | undefined {
    return findTaskProcess(taskPlanning.value?.processes ?? [], id)
  }

  /** Dependency edges of the process containing a task. */
  function dependencyEdgesOf(id: number): DependencyEdge[] {
    const p = findProcessOfTask(id)
    return (p?.dependencies ?? []).map((e: DtoTaskDependency) => ({
      id: e.id as number,
      task_id: e.task_id as number,
      depends_on_task_id: e.depends_on_task_id as number,
      type: e.type as DependencyType,
    }))
  }

  /** Date rows of the process's top-level tasks (the constraint engine input —
   *  links live on top-level tasks only). */
  function dateRowsOf(id: number): TaskDates[] {
    const p = findProcessOfTask(id)
    return (p?.tasks ?? []).map((t: DtoDetailedTask) => ({
      id: t.id as number,
      start_date: t.start_date as string,
      end_date: t.end_date as string,
    }))
  }

  /** Persists a Map of date patches in predecessor-first order (the backend
   *  guard validates a successor against its predecessors' committed dates).
   *  Optimistic patches are applied immediately; each PUT applies its own echoed
   *  row locally, and the coalesced post-mutation refresh re-reads the whole
   *  aggregate ONCE per burst (offline — each PUT goes to the outbox). */
  async function persistDatePatches(changes: Map<number, TaskDatePatch>): Promise<boolean> {
    if (changes.size === 0) return true
    const previous = new Map<number, { start_date?: string; end_date?: string }>()
    for (const [tid, patch] of changes) {
      const t = findTaskRow(tid)
      if (t) {
        previous.set(tid, { start_date: t.start_date, end_date: t.end_date })
        Object.assign(t, patch)
      }
    }
    const edges = dependencyEdgesOf([...changes.keys()][0])
    const order = persistenceOrder([...changes.keys()], edges)
    let ok = true
    for (const tid of order) {
      const patch = changes.get(tid)!
      const okOne = await runMutation({
        entity: 'task',
        call: () =>
          new TasksApi(apiConfig()).taskIdPut(tid, {
            start_date: patch.start_date,
            end_date: patch.end_date,
          }),
        // The echoed row (already clamped by the server) lands locally; the
        // aggregate is re-read once by the coalesced refresh — a per-task GET
        // here would multiply into one request per cascaded task.
        apply: (dto) => {
          const d = dto as { start_date?: string; end_date?: string } | null
          patchRow(findTaskRow(tid), { start_date: d?.start_date, end_date: d?.end_date })
        },
        optimistic: () => {
          const t = findTaskRow(tid)
          if (t) Object.assign(t, patch)
        },
        onError: (m) => {
          error.value = m
        },
      })
      if (!okOne) {
        // Keep the accepted prefix; rejected and unsubmitted dates were never confirmed.
        for (const pendingId of order.slice(order.indexOf(tid))) {
          const row = findTaskRow(pendingId)
          const proposed = changes.get(pendingId)!
          const rollback = taskDateRollback(row, proposed, previous.get(pendingId) ?? {})
          if (rollback) patchRow(row, rollback)
        }
        void refreshTaskPlanning(true)
        ok = false
        break
      }
    }
    return ok
  }

  /** Bar date shift WITH the dependency constraints: resolves the cascade
   *  (successors pushed right, the dragged task clamped to its bound) and
   *  persists every adjusted task in dependency order. Falls back to a plain
   *  date update when the task has no process context. */
  async function moveTask(id: number, start_date: string, end_date: string): Promise<boolean> {
    if (!findProcessOfTask(id)) return updateTaskDates(id, start_date, end_date)
    const changes = resolveTaskMove(dateRowsOf(id), dependencyEdgesOf(id), id, start_date, end_date)
    return persistDatePatches(changes)
  }

  /** Creates a dependency link. When the new link contradicts the schedule,
   *  the successor's dates are adjusted (and persisted) BEFORE the link is
   *  stored — the backend rejects an inconsistent link. */
  async function addTaskDependency(
    taskId: number,
    dependsOnTaskId: number,
    type: DependencyType,
  ): Promise<boolean> {
    if (findProcessOfTask(taskId)) {
      const adjust = resolveAddDependency(
        dateRowsOf(taskId),
        dependencyEdgesOf(taskId),
        taskId,
        dependsOnTaskId,
        type,
      )
      if (!(await persistDatePatches(adjust))) return false
    }
    return runMutation({
      entity: 'task',
      call: () =>
        new TasksApi(apiConfig()).taskIdDependenciesPost(taskId, {
          depends_on_task_id: dependsOnTaskId,
          type,
        }),
      apply: async () => {
        await refreshTaskPlanning(true)
      },
      optimistic: () => {
        const proc = findProcessOfTask(taskId)
        if (proc) {
          ;(proc.dependencies ??= []).push({
            id: nextTempId(),
            task_id: taskId,
            depends_on_task_id: dependsOnTaskId,
            type,
          })
        }
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Changes a link type; a type that contradicts the successor's dates first
   *  adjusts (and persists) the successor's dates. */
  async function changeTaskDependencyType(
    depId: number,
    taskId: number,
    type: DependencyType,
  ): Promise<boolean> {
    if (findProcessOfTask(taskId)) {
      const edges = dependencyEdgesOf(taskId).map((e) => (e.id === depId ? { ...e, type } : e))
      const adjust = resolveEdges(dateRowsOf(taskId), edges)
      if (!(await persistDatePatches(adjust))) return false
    }
    return runMutation({
      entity: 'task',
      call: () => new TasksApi(apiConfig()).taskIdDependenciesDepIdPut(taskId, depId, { type }),
      apply: async () => {
        await refreshTaskPlanning(true)
      },
      optimistic: () => {
        const proc = findProcessOfTask(taskId)
        const e = (proc?.dependencies ?? []).find((x: DtoTaskDependency) => x.id === depId)
        if (e) e.type = type
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Deletes a dependency link (idempotent). */
  async function deleteTaskDependency(depId: number, taskId: number): Promise<boolean> {
    return runMutation({
      entity: 'task',
      call: () => new TasksApi(apiConfig()).taskIdDependenciesDepIdDelete(taskId, depId),
      apply: async () => {
        await refreshTaskPlanning(true)
      },
      optimistic: () => {
        const proc = findProcessOfTask(taskId)
        if (proc) {
          proc.dependencies = (proc.dependencies ?? []).filter((x: DtoTaskDependency) => x.id !== depId)
        }
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function updateProcessDates(id: number, start_date: string, end_date: string): Promise<boolean> {
    const applyLocally = () => patchRow(findProcessRow(id), { start_date, end_date })
    applyLocally()
    return runMutation({
      entity: 'process',
      call: () => new ProcessesApi(apiConfig()).processIdPut(id, { start_date, end_date }),
      // The echoed row (already clamped into the project) lands locally; the
      // aggregate is re-read once by the coalesced refresh below.
      apply: (dto) => {
        const d = dto as { start_date?: string; end_date?: string } | null
        patchRow(findProcessRow(id), { start_date: d?.start_date, end_date: d?.end_date })
      },
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
        // A rejected span must not stick in the diagram: the server dates win.
        void refreshProcessPlanning(true)
      },
    })
  }

  async function updateProjectDates(id: number, start_date: string, end_date: string): Promise<boolean> {
    // The bar renders from the planning aggregate; the projects table reads the
    // app store list, so both copies take the drop immediately (same pairing as
    // updateProjectMeta — and both are restored on a rejected move).
    const applyLocally = () => {
      const d = { start_date, end_date }
      patchRow(findProjectRow(id), d)
      patchRow(useAppStore().projects.find((x) => x.id === id), { ...d })
    }
    applyLocally()
    return runMutation({
      entity: 'project',
      call: () => new ProjectsApi(apiConfig()).projectIdPut(id, { start_date, end_date }),
      apply: (dto) => {
        const d = dto as { start_date?: string; end_date?: string } | null
        const patch = { start_date: d?.start_date, end_date: d?.end_date }
        patchRow(findProjectRow(id), patch)
        patchRow(useAppStore().projects.find((x) => x.id === id), patch)
      },
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
        // A rejected span must not stick in the diagram: the server dates win.
        void refreshProjectPlanning(true)
        void useAppStore().refreshProjects()
      },
    })
  }

  /** Milestone shift (single date): PUT /milestone/{id}, applied locally. */
  async function updateMilestoneDate(id: number, date: string): Promise<boolean> {
    const applyLocally = () => patchRow(findMilestoneRow(id), { date })
    applyLocally()
    return runMutation({
      entity: 'milestone',
      call: () => new MilestonesApi(apiConfig()).milestoneIdPut(id, { date }),
      // The echoed row lands locally; tasks are re-read once by the coalesced
      // post-mutation refresh (the V4 trigger may shift the process's tasks).
      apply: (dto) => {
        const d = dto as { date?: string } | null
        patchRow(findMilestoneRow(id), { date: d?.date })
      },
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
        // A rejected date must not stick in the diagram: the server date wins.
        void refreshTaskPlanning(true)
      },
    })
  }

  async function updateProjectMeta(
    id: number,
    patch: { code?: string; owner_id?: number; responsible_id?: number; color?: string; start_date?: string; end_date?: string },
  ): Promise<boolean> {
    /** The PUT echoes the applied values; the aggregate and the app store list
     *  are re-read once by the coalesced post-mutation refresh. The rows carry
     *  `project_code`, while the request payload uses `code` — the previous
     *  optimistic patch wrote a stray `code` and left the shown code stale. */
    const applyLocally = () => {
      const row = {
        project_code: patch.code,
        owner_id: patch.owner_id,
        responsible_id: patch.responsible_id,
        color: patch.color,
        start_date: patch.start_date,
        end_date: patch.end_date,
      }
      patchRow(findProjectRow(id), row)
      patchRow(useAppStore().projects.find((x) => x.id === id), { ...row })
    }
    return runMutation({
      entity: 'project',
      call: () => new ProjectsApi(apiConfig()).projectIdPut(id, patch),
      apply: applyLocally,
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function updateProcessMeta(
    id: number,
    patch: { title?: string; owner_id?: number; responsible_id?: number; color?: string; start_date?: string; end_date?: string },
  ): Promise<boolean> {
    const previousOwner = taskPlanning.value?.processes?.find((p) => p.id === id)?.owner_id ?? findProcessRow(id)?.owner_id
    const applyLocally = () => {
      patchRow(findProcessRow(id), patch)
      const process = taskPlanning.value?.processes?.find((p) => p.id === id)
      if (process && patch.owner_id != null && patch.owner_id !== previousOwner) {
        process.owner_id = patch.owner_id
        for (const task of process.tasks ?? []) task.resources = []
      }
    }
    return runMutation({
      entity: 'process',
      call: () => new ProcessesApi(apiConfig()).processIdPut(id, patch),
      apply: applyLocally,
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function updateTaskMeta(
    id: number,
    patch: { title?: string; owner_id?: number; responsible_id?: number; color?: string; status?: string },
  ): Promise<boolean> {
    const applyLocally = () => patchRow(findTaskRow(id), patch)
    return mutateTask(id, patch, applyLocally, applyLocally, (m) => {
      error.value = m
    })
  }

  async function updateMilestoneMeta(
    id: number,
    patch: { title?: string; content?: string; color?: string },
  ): Promise<boolean> {
    const applyLocally = () => patchRow(findMilestoneRow(id), patch)
    return runMutation({
      entity: 'milestone',
      call: () => new MilestonesApi(apiConfig()).milestoneIdPut(id, patch),
      apply: applyLocally,
      optimistic: applyLocally,
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Inserts an item into an array by index (shifts rows down); index defaults to the end. */
  function insertAt<T>(list: T[] | null | undefined, index: number | undefined, item: T): void {
    if (!list) return
    const i = index == null || index < 0 || index > list.length ? list.length : index
    list.splice(i, 0, item)
  }

  /** Creates a project with a fixed priority of 100 — at the end of the list.
   *  Returns what the auto-create template (server-side trigger) added to the
   *  project (null when offline/optimistic or the template is empty). */
  async function createProject(
    payload: {
      code: string
      start_date: string
      end_date: string
      priority?: number
      color?: string
    },
  ): Promise<{ ok: boolean; autoCreated: DtoAutoCreatedCounts | null }> {
    const tempId = nextTempId()
    let autoCreated: DtoAutoCreatedCounts | null = null
    const ok = await runMutation({
      entity: 'project',
      tempId,
      call: async () => {
        const resp = await new ProjectsApi(apiConfig()).projectPost({ ...payload, priority: 100 })
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (dto) => {
        if (!dto) return
        const d = dto as {
          id?: number
          code?: string
          start_date?: string
          end_date?: string
          priority?: number
          owner_id?: number
          color?: string
          auto_created?: DtoAutoCreatedCounts
        }
        const ac = d.auto_created
        if (ac && (ac.processes || ac.tasks || ac.assignments)) autoCreated = ac
        const item = {
          id: d.id ?? 0,
          project_code: d.code ?? payload.code,
          start_date: d.start_date ?? payload.start_date,
          end_date: d.end_date ?? payload.end_date,
          priority: d.priority ?? 100,
          owner_id: d.owner_id,
          color: d.color,
        }
        const app = useAppStore()
        insertAt(projectPlanning.value?.projects, undefined, item)
        insertAt(app.projects, undefined, item)
        // Immediate visibility in the processes aggregate too (the coalesced
        // post-mutation refresh confirms the group and extends it with the
        // auto-created processes/tasks).
        insertAt(processPlanning.value?.projects, undefined, {
          id: item.id,
          project_code: item.project_code,
          start_date: item.start_date,
          end_date: item.end_date,
          priority: item.priority,
          processes: [],
        })
      },
      optimistic: () => {
        const item = {
          id: tempId,
          project_code: payload.code,
          start_date: payload.start_date,
          end_date: payload.end_date,
          priority: payload.priority ?? 100,
          owner_id: undefined,
          color: payload.color,
        }
        const app = useAppStore()
        insertAt(projectPlanning.value?.projects, undefined, item)
        insertAt(app.projects, undefined, item)
        insertAt(processPlanning.value?.projects, undefined, {
          id: tempId,
          project_code: payload.code,
          start_date: payload.start_date,
          end_date: payload.end_date,
          priority: payload.priority ?? 100,
          processes: [],
        })
      },
      onError: (m) => {
        error.value = m
      },
    })
    return { ok, autoCreated }
  }

  async function createProcess(
    payload: {
      title: string
      project_id: number
      start_date: string
      end_date: string
      color?: string
    },
    index?: number,
  ): Promise<boolean> {
    const tempId = nextTempId()
    return runMutation({
      entity: 'process',
      tempId,
      call: async () => {
        const resp = await new ProcessesApi(apiConfig()).processPost(payload)
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (dto) => {
        if (!dto) return
        const d = dto as { id?: number; title?: string; start_date?: string; end_date?: string; color?: string }
        const project = processPlanning.value?.projects?.find((p: DtoDetailedProject) => p.id === payload.project_id)
        insertAt(project?.processes, index, {
          id: d.id ?? 0,
          title: d.title ?? payload.title,
          start_date: d.start_date ?? payload.start_date,
          end_date: d.end_date ?? payload.end_date,
          project_id: payload.project_id,
          color: d.color ?? payload.color,
        })
      },
      optimistic: () => {
        const project = processPlanning.value?.projects?.find((p: DtoDetailedProject) => p.id === payload.project_id)
        insertAt(project?.processes, index, {
          id: tempId,
          title: payload.title,
          start_date: payload.start_date,
          end_date: payload.end_date,
          project_id: payload.project_id,
          color: payload.color,
        })
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function createTask(
    payload: {
      title: string
      process_id: number
      start_date: string
      end_date: string
      color?: string
      status?: string
    },
    index?: number,
  ): Promise<boolean> {
    const tempId = nextTempId()
    return runMutation({
      entity: 'task',
      tempId,
      call: async () => {
        const resp = await new TasksApi(apiConfig()).taskPost(payload)
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (dto) => {
        if (!dto) return
        const d = dto as { id?: number; title?: string; start_date?: string; end_date?: string; color?: string; status?: string }
        const proc = taskPlanning.value?.processes?.find((p: DtoDetailedProcess) => p.id === payload.process_id)
        insertAt(proc?.tasks, index, {
          id: d.id ?? 0,
          title: d.title ?? payload.title,
          start_date: d.start_date ?? payload.start_date,
          end_date: d.end_date ?? payload.end_date,
          resources: [],
          color: d.color ?? payload.color,
          status: d.status ?? payload.status ?? 'not_started',
        })
      },
      optimistic: () => {
        const proc = taskPlanning.value?.processes?.find((p: DtoDetailedProcess) => p.id === payload.process_id)
        insertAt(proc?.tasks, index, {
          id: tempId,
          title: payload.title,
          start_date: payload.start_date,
          end_date: payload.end_date,
          resources: [],
          color: payload.color,
          status: payload.status ?? 'not_started',
        })
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Creates a subtask (operation) attached to a top-level task. The backend
   *  inherits the parent's process and dates, so only title/color/status are
   *  sent. Optimistically appended to the parent's subtasks list. */
  async function createSubtask(
    parentId: number,
    payload: { title: string; color?: string; status?: string },
  ): Promise<boolean> {
    const tempId = nextTempId()
    const parent = findTaskRow(parentId)
    return runMutation({
      entity: 'task',
      tempId,
      call: async () => {
        const resp = await new TasksApi(apiConfig()).taskPost({
          parent_id: parentId,
          // The RBAC middleware authorizes task.create by the process from the
          // body; a subtask always lives in its parent's process.
          process_id: parent?.process_id,
          title: payload.title,
          color: payload.color,
          status: payload.status,
        })
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (dto) => {
        if (!dto) return
        const d = dto as { id?: number; title?: string; color?: string; status?: string }
        const p = findTaskRow(parentId)
        if (!p) return
        ;(p.subtasks ??= []).push({
          id: d.id ?? 0,
          title: d.title ?? payload.title,
          color: d.color ?? payload.color,
          status: d.status ?? payload.status ?? 'not_started',
          resources: [],
          subtasks: [],
        })
      },
      optimistic: () => {
        if (!parent) return
        ;(parent.subtasks ??= []).push({
          id: tempId,
          title: payload.title,
          color: payload.color,
          status: payload.status ?? 'not_started',
          resources: [],
          subtasks: [],
        })
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Updates a subtask: title/color/status via PUT /task/{id}. */
  async function updateSubtask(
    id: number,
    patch: { title?: string; color?: string; status?: string },
  ): Promise<boolean> {
    const applyLocally = () => patchRow(findTaskRow(id), patch)
    return mutateTask(id, patch, applyLocally, applyLocally, (m) => {
      error.value = m
    })
  }

  /** Deletes a subtask (or a top-level task — both share PUT/Delete routes). */
  async function deleteSubtask(id: number): Promise<boolean> {
    const remove = () => {
      const owner = findSubtaskOwner(id)
      if (owner) removeById(owner.subtasks, id)
      else for (const p of taskPlanning.value?.processes ?? []) removeById(p.tasks, id)
    }
    return runMutation({
      entity: 'task',
      call: () => new TasksApi(apiConfig()).taskIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function createMilestone(payload: {
    title: string
    content?: string
    process_id: number
    date: string
    color?: string
  }): Promise<boolean> {
    const tempId = nextTempId()
    return runMutation({
      entity: 'milestone',
      tempId,
      call: async () => {
        const resp = await new MilestonesApi(apiConfig()).milestonePost(payload)
        const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
        if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
        return resp
      },
      apply: (dto) => {
        if (!dto) return
        const d = dto as { id?: number; title?: string; content?: string; date?: string; color?: string }
        const proc = taskPlanning.value?.processes?.find((p: DtoDetailedProcess) => p.id === payload.process_id)
        proc?.milestones?.push({
          id: d.id ?? 0,
          title: d.title ?? payload.title,
          content: d.content ?? payload.content ?? '',
          date: d.date ?? payload.date,
          color: d.color ?? payload.color,
        })
      },
      optimistic: () => {
        const proc = taskPlanning.value?.processes?.find((p: DtoDetailedProcess) => p.id === payload.process_id)
        proc?.milestones?.push({
          id: tempId,
          title: payload.title,
          content: payload.content ?? '',
          date: payload.date,
          color: payload.color,
        })
      },
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Removes an item from an array by id (no-op if the list or the item is missing). */
  function removeById<T extends { id?: number }>(list: T[] | null | undefined, id: number): void {
    if (!list) return
    const i = list.findIndex((x) => x.id === id)
    if (i >= 0) list.splice(i, 1)
  }

  async function deleteProject(id: number): Promise<boolean> {
    const remove = () => {
      removeById(projectPlanning.value?.projects, id)
      removeById(useAppStore().projects, id)
      // Cascade into the sibling aggregates so the deleted project's processes
      // (and their task groups) vanish from the Process/Task Gantts immediately —
      // the coalesced refetch confirms the server-side cascade afterwards.
      removeById(processPlanning.value?.projects, id)
      if (Array.isArray(taskPlanning.value?.processes)) {
        const kept = taskPlanning.value.processes.filter((p: DtoDetailedProcess) => p.project_id !== id)
        if (kept.length !== taskPlanning.value.processes.length) {
          taskPlanning.value.processes = kept
        }
      }
    }
    return runMutation({
      entity: 'project',
      call: () => new ProjectsApi(apiConfig()).projectIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function deleteProcess(id: number): Promise<boolean> {
    const remove = () => {
      for (const p of processPlanning.value?.projects ?? []) removeById(p.processes, id)
    }
    return runMutation({
      entity: 'process',
      call: () => new ProcessesApi(apiConfig()).processIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function deleteTask(id: number): Promise<boolean> {
    const remove = () => {
      const owner = findSubtaskOwner(id)
      if (owner) removeById(owner.subtasks, id)
      else for (const p of taskPlanning.value?.processes ?? []) removeById(p.tasks, id)
    }
    return runMutation({
      entity: 'task',
      call: () => new TasksApi(apiConfig()).taskIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        error.value = m
      },
    })
  }

  async function deleteMilestone(id: number): Promise<boolean> {
    const remove = () => {
      for (const p of taskPlanning.value?.processes ?? []) removeById(p.milestones, id)
    }
    return runMutation({
      entity: 'milestone',
      call: () => new MilestonesApi(apiConfig()).milestoneIdDelete(id),
      apply: remove,
      optimistic: remove,
      onError: (m) => {
        error.value = m
      },
    })
  }

  /** Finds a task's resource (from /planning/tasks) by resource_id together with assignment_id */
  function findAssigned(taskId: number, resourceId: number) {
    const t = findTaskRow(taskId)
    if (!t) return undefined
    return (t.resources ?? []).find((r: DtoResource) => r.id === resourceId) as
      | { id?: number; assignment_id?: number }
      | undefined
  }

  /**
   * Task owners (process/project) from the loaded planning data.
   * An empty list — the data is unknown (cold cache): the check is skipped,
   * the final word stays with the server.
   */
  function taskOwnerIds(taskId: number): number[] {
    const owners: number[] = []
    // Subtasks share their parent's process (enforced by the backend).
    const process = (taskPlanning.value?.processes ?? []).find(
      (p: DtoDetailedProcess) =>
        (p.tasks ?? []).some((t: DtoDetailedTask) => t.id === taskId || (t.subtasks ?? []).some((s: DtoDetailedTask) => s.id === taskId)),
    )
    if (!process) return owners
    if (process.owner_id != null) owners.push(process.owner_id)
    const project =
      projectPlanning.value?.projects?.find((pr: DtoProject) => pr.id === process.project_id) ??
      useAppStore().projects.find((pr: DtoProject) => pr.id === process.project_id)
    if (project?.owner_id != null) owners.push(project.owner_id)
    return owners
  }

  /**
   * Assigns a resource to a task: POST /assignment + silent reload of tasks.
   * Owners are checked beforehand (the data is already in the planning cache) for a
   * scope narrower than "all": a definitely-403 assignment goes neither to an online
   * request nor to the offline queue. A global assignment.create scope (or the admin
   * preset on a cold start) skips the pre-check — the backend still enforces.
   */
  async function assignResource(
    taskId: number,
    resourceId: number,
    quantity: number,
  ): Promise<boolean> {
    const auth = useAuthStore()
    const rbac = useRbacStore()
    const permsReady = rbac.permsLoaded || rbac.myPermissions.length > 0
    const assignAll = permsReady ? rbac.perm('assignment', 'create') === 'all' : auth.user?.preset === 'admin'
    const process = findProcessOfTask(taskId)
    const resource = useAppStore().resources.find((r) => r.id === resourceId)
    if (!assignmentAllowed({
      processOwner: process?.owner_id, resourceOwner: resource?.owner_id,
      taskOwner: findTaskRow(taskId)?.owner_id, userId: auth.user?.id, all: assignAll,
    })) {
      error.value = t('offline.assignment.foreignResource')
      return false
    }
    const tempId = nextTempId()
    const add = () => {
      const task = findTaskRow(taskId)
      if (!task) return
      const meta = useAppStore().resources.find((r) => r.id === resourceId)
      task.resources = addResourceAssignment(task.resources ?? [], {
        id: resourceId, assignment_id: tempId, quantity, code: meta?.code, title: meta?.title, color: meta?.color,
      })
    }
    add()
    return runMutation({
      entity: 'assignment',
      tempId,
      call: () => new AssignmentsApi(apiConfig()).assignmentPost({ task_id: taskId, resource_id: resourceId, quantity }),
      apply: async (dto) => {
        const assignment = dto as DtoAssignmentResponse | null
        const row = findTaskRow(taskId)?.resources?.find((r) => r.assignment_id === tempId)
        if (row && assignment?.id != null) row.assignment_id = assignment.id
        await refreshTaskPlanning(true)
      },
      optimistic: add,
      onError: (m) => {
        error.value = m
        const task = findTaskRow(taskId)
        if (task) task.resources = removeResourceAssignment(task.resources ?? [], tempId, 'assignment')
      },
    })
  }

  /** Removes a resource assignment from a task: DELETE /assignment/{id} (by assignment_id from
   *  /planning/tasks, otherwise falls back to GET /assignment → lookup by (task_id, resource_id)).
   *  On success — silent reload of tasks. */
  async function removeResource(taskId: number, resourceId: number): Promise<boolean> {
    const found = findAssigned(taskId, resourceId)
    let assignmentId: number | undefined
    if (found?.assignment_id) {
      assignmentId = found.assignment_id
    } else {
      try {
        const resp = await new AssignmentsApi(apiConfig()).assignmentGet(500, undefined, 0)
        const data = resp.data?.data
        const list = data?.items ?? []
        const a = list.find((x: DtoAssignmentResponse) => x.task_id === taskId && x.resource_id === resourceId)
        if (a?.id == null) {
          error.value = t('offline.assignment.notFound')
          return false
        }
        assignmentId = a.id
      } catch (e: unknown) {
        error.value = e instanceof Error ? e.message || String(e) : String(e)
        return false
      }
    }
    const task = findTaskRow(taskId)
    const removed = task?.resources?.find((r) => r.id === resourceId)
    const remove = () => {
      const row = findTaskRow(taskId)
      if (row) row.resources = removeResourceAssignment(row.resources ?? [], resourceId, 'resource')
    }
    remove()
    return runMutation({
      entity: 'assignment',
      call: () => new AssignmentsApi(apiConfig()).assignmentIdDelete(assignmentId!),
      apply: async () => {
        await refreshTaskPlanning(true)
      },
      optimistic: remove,
      onError: (m) => {
        error.value = m
        const row = findTaskRow(taskId)
        if (row && removed && !row.resources?.some((r) => r.id === resourceId)) {
          row.resources = [...(row.resources ?? []), removed]
        }
      },
    })
  }

  /** Reorders projects (row drag): new priorities = index+1, PUTs are sent
   *  only for the changed ones — the moved project and those shifted between positions.
   *  On error, silently reload the data (rolling back to the server order). */
  async function reorderProjects(from: number, to: number): Promise<boolean> {
    const list = projectPlanning.value?.projects
    if (!Array.isArray(list) || from === to) return true
    const reordered = reorderItems(list, from, to)
    if (!reordered) return false
    for (let i = 0; i < reordered.length; i++) list[i] = reordered[i]

    const changes = projectPriorityChanges(list)
    if (!changes.length) return true

    try {
      await Promise.all(
        changes.map((c) => new ProjectsApi(apiConfig()).projectIdPut(c.id, { priority: c.priority })),
      )
    } catch (e: unknown) {
      const err = e as AxiosError
      if (err?.config && isNetworkError(e)) {
        // Offline: the local reorder is already applied; the PUTs go to the queue.
        const base = axios.getUri(err.config).replace(/\d+$/, '')
        for (const c of changes) {
          try {
            await enqueueMutation({
              entity: 'project',
              method: (err.config.method ?? 'put') as Method,
              url: `${base}${c.id}`,
              body: { priority: c.priority },
            })
          } catch {
            // queue unavailable — fall back to a regular error
            error.value = e instanceof Error ? e.message : String(e)
            await refreshProjectPlanning(true)
            return false
          }
        }
        return true
      }
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      await refreshProjectPlanning(true)
      return false
    }

    await refreshProjectPlanning(true)
    const appProjects = useAppStore().projects
    if (Array.isArray(appProjects)) {
      for (const p of appProjects) {
        const c = changes.find((x) => x.id === p.id)
        if (c) p.priority = c.priority
      }
    }
    return true
  }

  /** Reorders the processes of one project (row drag): renumbers the order
   *  values locally and sends the complete ordered id list to /process/order.
   *  Offline (desktop) — the reorder is queued; on any other error the data is
   *  silently reloaded (server order wins). */
  async function reorderProcesses(projectId: number, from: number, to: number): Promise<boolean> {
    const project = processPlanning.value?.projects?.find((p: DtoDetailedProject) => p.id === projectId)
    const list = project?.processes
    if (!Array.isArray(list) || from === to) return true
    const reordered = reorderItems(list, from, to)
    if (!reordered) return false
    for (let i = 0; i < reordered.length; i++) list[i] = reordered[i]
    list.forEach((p: DtoProcess, i: number) => {
      p.order = i + 1
    })
    const ids = list.map((p: DtoProcess) => p.id as number)

    try {
      await new ProcessesApi(apiConfig()).processOrderPut({ project_id: projectId, ids })
    } catch (e: unknown) {
      const err = e as AxiosError
      if (err?.config && isNetworkError(e)) {
        try {
          await enqueueMutation({
            entity: 'reorder',
            method: (err.config.method ?? 'put') as Method,
            url: axios.getUri(err.config),
            body: { project_id: projectId, ids },
          })
        } catch {
          error.value = e instanceof Error ? e.message : String(e)
          await refreshProcessPlanning(true)
          return false
        }
        return true
      }
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      await refreshProcessPlanning(true)
      return false
    }
    return true
  }

  /** Reorders the tasks of one process (row drag): renumbers the order values
   *  locally and sends the complete ordered id list to /task/order.
   *  Offline (desktop) — the reorder is queued; on any other error the data is
   *  silently reloaded (server order wins). */
  async function reorderTasks(processId: number, from: number, to: number): Promise<boolean> {
    const process = taskPlanning.value?.processes?.find((p: DtoDetailedProcess) => p.id === processId)
    const list = process?.tasks
    if (!Array.isArray(list) || from === to) return true
    const reordered = reorderItems(list, from, to)
    if (!reordered) return false
    for (let i = 0; i < reordered.length; i++) list[i] = reordered[i]
    list.forEach((t: DtoDetailedTask, i: number) => {
      t.order = i + 1
    })
    const ids = list.map((t: DtoDetailedTask) => t.id as number)

    try {
      await new TasksApi(apiConfig()).taskOrderPut({ process_id: processId, ids })
    } catch (e: unknown) {
      const err = e as AxiosError
      if (err?.config && isNetworkError(e)) {
        try {
          await enqueueMutation({
            entity: 'reorder',
            method: (err.config.method ?? 'put') as Method,
            url: axios.getUri(err.config),
            body: { process_id: processId, ids },
          })
        } catch {
          error.value = e instanceof Error ? e.message : String(e)
          await refreshTaskPlanning(true)
          return false
        }
        return true
      }
      error.value = e instanceof Error ? e.message || String(e) : String(e)
      await refreshTaskPlanning(true)
      return false
    }
    return true
  }

  // === Task comments ===
  /** Loads a task's comments into the cache by task_id.
   *  - fresh (default) — always request online (opening the modal);
   *  - fresh:false — serve the cache if already present (task tooltip hover);
   *  - offline — cache only (online-only). */
  async function loadTaskComments(taskId: number, opts?: { fresh?: boolean }): Promise<void> {
    if (commentsByTask.value[taskId] != null && !opts?.fresh) return
    if (isOffline.value && commentsByTask.value[taskId] != null) return
    commentsLoading.value = true
    commentsError.value = null
    try {
      const resp = await new TasksApi(apiConfig()).taskIdCommentsGet(taskId)
      commentsByTask.value[taskId] = (resp.data?.data as DtoCommentResponse[] | undefined) ?? []
    } catch (e: unknown) {
      commentsError.value = e instanceof Error ? e.message || String(e) : String(e)
    } finally {
      commentsLoading.value = false
    }
  }

  /** Creates a task comment (parent_id — a reply to a comment of the same task). */
  async function createTaskComment(
    taskId: number,
    content: string,
    parentId?: number,
  ): Promise<boolean> {
    try {
      const resp = await new TasksApi(apiConfig()).taskIdCommentsPost(taskId, {
        content,
        parent_id: parentId,
      })
      const errBody = resp.data?.error as { code?: unknown; message?: string } | undefined
      if (errBody && errBody.code != null) throw new Error(apiErrorMessage(errBody))
      const dto = resp.data?.data as DtoCommentResponse | undefined
      if (dto) {
        const list = commentsByTask.value[taskId] ?? []
        list.push(dto)
        commentsByTask.value[taskId] = [...list]
      }
      // Keep the task-bar comment badge in sync with the comment list
      const task = findTaskRow(taskId)
      if (task) task.comments_count = (task.comments_count ?? 0) + 1
      return true
    } catch {
      // A failed comment mutation is reported by the global toast (http.ts) —
      // the inline modal error stays for load failures only (loadTaskComments).
      return false
    }
  }

  /** Deletes a comment (softly; replies stay — they become "orphaned" in the tree). */
  async function deleteTaskComment(taskId: number, commentId: number): Promise<boolean> {
    try {
      await new TasksApi(apiConfig()).taskIdCommentsCommentIdDelete(taskId, commentId)
      const list = commentsByTask.value[taskId]
      if (list) commentsByTask.value[taskId] = list.filter((c) => c.id !== commentId)
      // Keep the task-bar comment badge in sync (floor at 0 in case of drift)
      const task = findTaskRow(taskId)
      if (task) task.comments_count = Math.max(0, (task.comments_count ?? 0) - 1)
      return true
    } catch {
      // A failed comment mutation is reported by the global toast (http.ts) —
      // the inline modal error stays for load failures only (loadTaskComments).
      return false
    }
  }

  /** Clears the user-scoped planning payloads on logout/account switch (the GET
   *  cache itself is per-user keyed — see offline/cache.ts). */
  function resetUserData(): void {
    taskContext++
    taskReads.invalidate()
    projectPlanning.value = null
    processPlanning.value = null
    taskPlanning.value = null
    commentsByTask.value = {}
  }

  return {
    projectPlanning,
    processPlanning,
    taskPlanning,
    loading,
    error,
    commentsByTask,
    commentsLoading,
    commentsError,
    loadProjectPlanning,
    loadProcessPlanning,
    loadTaskPlanning,
    refreshProjectPlanning,
    refreshProcessPlanning,
    refreshTaskPlanning,
    updateTaskDates,
    moveTask,
    addTaskDependency,
    changeTaskDependencyType,
    deleteTaskDependency,
    updateProcessDates,
    updateProjectDates,
    updateMilestoneDate,
    updateProjectMeta,
    updateProcessMeta,
    updateTaskMeta,
    updateMilestoneMeta,
    createProject,
    createProcess,
    createTask,
    createSubtask,
    updateSubtask,
    deleteSubtask,
    createMilestone,
    deleteProject,
    deleteProcess,
    deleteTask,
    deleteMilestone,
    assignResource,
    removeResource,
    taskOwnerIds,
    reorderProjects,
    reorderProcesses,
    reorderTasks,
    loadTaskComments,
    createTaskComment,
    deleteTaskComment,
    resetUserData,
  }
})

// =============================================================
// RBAC policies (permission matrix) — the admin editor.
// Roles are now presets of permissions; users get individual overrides.
// All operations are online-only (no outbox/offline support needed).
// =============================================================
export const useRbacStore = defineStore('rbac', () => {
  const presets = ref<DtoPresetView[]>([])
  /** Active preset matrix rules (with id — needed to delete "no access" entries). */
  const presetRules = ref<DtoPresetRuleView[]>([])
  /** Effective matrix (with the admin bypass) — the display source. */
  const matrix = ref<DtoMatrixCell[]>([])
  /** Route checks (read-only reference). */
  const routePolicies = ref<DtoRoutePolicyView[]>([])
  /** Reference of route check kinds. */
  const kinds = ref<EngineKindInfo[]>([])
  const loading = ref(false)
  const saving = ref(false)
  const error = ref<string | null>(null)

  /** Per-user permissions of the edited user (the UserPermissionsEditor). */
  const userPermissions = ref<DtoUserPermissionsView | null>(null)
  const userPermissionsLoading = ref(false)
  const userPermissionsError = ref<string | null>(null)

  function setError(e: unknown) {
    error.value = e instanceof Error ? e.message : String(e)
  }

  /** Loads the whole RBAC reference in one pass. */
  async function loadRbac(): Promise<boolean> {
    if (loading.value) return false
    loading.value = true
    error.value = null
    try {
      const api = new RBACApi(apiConfig())
      const [presetsR, rulesR, matrixR, routesR, kindsR] = await Promise.all([
        api.rbacPresetsGet(),
        api.rbacPresetRulesGet(),
        api.rbacMatrixGet(),
        api.rbacPoliciesGet(),
        api.rbacKindsGet(),
      ])
      presets.value = presetsR.data?.data ?? []
      presetRules.value = rulesR.data?.data ?? []
      matrix.value = matrixR.data?.data ?? []
      routePolicies.value = routesR.data?.data ?? []
      kinds.value = kindsR.data?.data ?? []
      return true
    } catch (e) {
      setError(e)
      return false
    } finally {
      loading.value = false
    }
  }

  /** My permissions (by the matrix) — the source of UI capabilities instead of roles. */
  const myPermissions = ref<DtoPermission[]>([])
  const permsLoaded = ref(false)

  /**
   * Ownership (ABAC) satisfaction by scope — the client-side mirror of the
   * backend owner-chain evaluation (internal/authz/engine eval.go). The scope
   * is a TREE EXPRESSION (all/self/up1/up/sib/down/…); owners come from the
   * card data (planning/app stores), not from the permission list. sib/down
   * moves need the tree data — the caller supplies the probe results.
   * Expressions come from /permissions/me (the Casbin snapshot).
   */
  function scopeSatisfied(scope: string, resource: string, uid: number, o: { owner?: number | null; projectOwner?: number | null; processOwner?: number | null }, probe?: ScopeProbe): boolean {
    return evalScope(scope, resource, o, uid, probe)
  }

  /** Whether the current role has the right to the action at all. */
  function can(resource: string, action: string): boolean {
    return myPermissions.value.some((p) => p.resource === resource && p.action === action && p.scope !== 'none' && p.scope !== '')
  }

  /** The right's scope ('' — no right). */
  function perm(resource: string, action: string): string {
    return parentScope(resource, myPermissions.value.find((p) => p.resource === resource && p.action === action)?.scope ?? '')
  }

  /** Right + object ownership by scope (owners — from the card data). */
  function canOwn(
    resource: string,
    action: string,
    owners: { owner?: number | null; projectOwner?: number | null; processOwner?: number | null },
    probe?: ScopeProbe,
  ): boolean {
    const scope = perm(resource, action)
    if (!scope) return false
    const auth = useAuthStore()
    return scopeSatisfied(scope, resource, auth.user?.id ?? 0, owners, probe)
  }

  /**
   * Loads my permissions — LOCAL-FIRST (read the cached copy, never issue a GET
   * from the render/guard path). The background PULL cycle owns the network
   * refresh (refreshPermissions).
   */
  async function loadMyPermissions(): Promise<boolean> {
    if (permsLoaded.value) return true
    try {
      const cached = localStorage.getItem(permsKey(useAuthStore().user?.id))
      if (cached) {
        const parsed = JSON.parse(cached)
        // Defensive: a valid-JSON non-array payload must not overwrite the ref
        // (would break rbac.can()'s .some()).
        if (Array.isArray(parsed)) myPermissions.value = parsed
      }
    } catch {
      /* cache unreadable — no permissions */
    }
    // An empty/missing/corrupt cache does NOT count as loaded: the router guard
    // falls back to the planner-role check while permsLoaded is false, and the
    // background sync (refreshPermissions) populates the list afterwards.
    permsLoaded.value = myPermissions.value.length > 0
    return permsLoaded.value
  }

  /** Network refresh of my permissions (PULL). Falls back to cache when offline. */
  async function refreshPermissions(): Promise<boolean> {
    if (isOffline.value) return loadMyPermissions()
    try {
      const resp = await new PermissionsApi(apiConfig()).permissionsMeGet()
      myPermissions.value = resp.data?.data ?? []
      permsLoaded.value = true
      try {
        localStorage.setItem(
          permsKey(useAuthStore().user?.id),
          JSON.stringify(myPermissions.value),
        )
      } catch {
        /* localStorage may be unavailable */
      }
      return true
    } catch {
      return false
    }
  }

  /**
   * Drops the in-memory permission snapshot (called on account switch and
   * logout): the UI must never keep rights of another user. The next
   * /permissions/me (login refresh / router-guard load / TTL pull) fills it.
   */
  function resetPermissions() {
    myPermissions.value = []
    permsLoaded.value = false
  }

  /** Periodic permissions sync (TTL polling following the backend). */
  function startPermissionSync(ms = 30000): () => void {
    let timer: number | undefined
    const stopVisibility = () => document.removeEventListener('visibilitychange', onVisibility)
    const tick = () => {
      if (!document.hidden) void refreshPermissions()
    }
    const onVisibility = () => {
      if (document.hidden && timer != null) {
        window.clearInterval(timer)
        timer = undefined
      } else if (!document.hidden && timer == null) {
        timer = window.setInterval(tick, ms)
        void loadMyPermissions()
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => {
      if (timer != null) window.clearInterval(timer)
      if (stopVisibility) stopVisibility()
    }
  }

  /** Lightweight load of the presets catalog (for selects without a full loadRbac). */
  async function ensurePresets(): Promise<void> {
    if (presets.value.length) return
    try {
      const presetsR = await new RBACApi(apiConfig()).rbacPresetsGet()
      presets.value = presetsR.data?.data ?? []
    } catch {
      // catalog unavailable — the UI works off a static preset list
    }
  }

  /** Re-reads the preset rules and matrix after a change (an "immediate" effect). */
  async function reloadRules(): Promise<boolean> {
    try {
      const api = new RBACApi(apiConfig())
      const [rulesR, matrixR] = await Promise.all([api.rbacPresetRulesGet(), api.rbacMatrixGet()])
      presetRules.value = rulesR.data?.data ?? []
      matrix.value = matrixR.data?.data ?? []
      return true
    } catch (e) {
      setError(e)
      return false
    }
  }

  /** Writes a preset rule (upsert by preset+resource+action). */
  async function upsertRule(input: DtoPresetRuleInput): Promise<boolean> {
    try {
      await new RBACApi(apiConfig()).rbacPresetRulesPut(input)
      return true
    } catch (e) {
      setError(e)
      return false
    }
  }

  /** Soft deletion of a preset rule (the "no access" zone). */
  async function deleteRule(id: number): Promise<boolean> {
    try {
      await new RBACApi(apiConfig()).rbacPresetRulesIdDelete(id)
      return true
    } catch (e) {
      setError(e)
      return false
    }
  }

  /** Creates (or revives) a preset and updates the local catalog. */
  async function createPreset(input: { tag: string; name: string; description?: string }): Promise<boolean> {
    try {
      const resp = await new RBACApi(apiConfig()).rbacPresetsPost({
        tag: input.tag,
        name: input.name,
        description: input.description ?? '',
      })
      if (resp.data?.data) {
        presets.value = [...presets.value.filter((r) => r.tag !== resp.data?.data?.tag), resp.data.data]
      }
      return true
    } catch {
      return false
    }
  }

  /** Updates a preset: optional tag rename (patch.tag) plus name and description. */
  async function updatePreset(
    tag: string,
    patch: { tag?: string; name: string; description: string },
  ): Promise<boolean> {
    try {
      const resp = await new RBACApi(apiConfig()).rbacPresetsTagPut(tag, {
        tag: patch.tag,
        name: patch.name,
        description: patch.description,
      })
      const saved = resp.data?.data
      if (saved) {
        presets.value = presets.value
          .filter((r) => r.tag !== tag)
          .concat({ tag: saved.tag ?? tag, name: saved.name ?? '', description: saved.description ?? '' })
      }
      return true
    } catch {
      return false
    }
  }

  /** Softly deletes a preset (and its rules) and removes it from the local catalog. */
  async function deletePreset(tag: string): Promise<boolean> {
    try {
      await new RBACApi(apiConfig()).rbacPresetsTagDelete(tag)
      presets.value = presets.value.filter((r) => r.tag !== tag)
      return true
    } catch {
      return false
    }
  }

  let userPermissionRead = 0
  let userPermissionReadId: number | null = null

  /** Loads the per-user permissions view (assigned preset + overrides + effective). */
  async function loadUserPermissions(id: number): Promise<boolean> {
    const read = ++userPermissionRead
    userPermissionReadId = id
    userPermissionsLoading.value = true
    userPermissionsError.value = null
    // Keep same-user refreshes usable while concealing another user's snapshot.
    if (userPermissions.value?.user_id !== id) userPermissions.value = null
    try {
      const resp = await new RBACApi(apiConfig()).rbacUsersIdPermissionsGet(id)
      if (read !== userPermissionRead) return false
      userPermissions.value = resp.data?.data ?? null
      return true
    } catch (e: unknown) {
      if (read === userPermissionRead) userPermissionsError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      return false
    } finally {
      if (read === userPermissionRead) userPermissionsLoading.value = false
    }
  }

  /** Replaces the user's overrides (full replacement, applied immediately). */
  async function saveUserPermissions(id: number, overrides: DtoUserPermissionsInput['overrides']): Promise<boolean> {
    try {
      const body: DtoUserPermissionsInput = { overrides }
      await new RBACApi(apiConfig()).rbacUsersIdPermissionsPut(id, body)
      if (userPermissionReadId === id) {
        userPermissionRead++
        userPermissionsLoading.value = false
      }
      if (userPermissions.value?.user_id === id) {
        userPermissions.value = { ...userPermissions.value, overrides: (overrides ?? []).map((rule) => ({ ...rule })) }
      }
      if (userPermissionReadId === id || userPermissions.value?.user_id === id) userPermissionsError.value = null
      return true
    } catch (e: unknown) {
      if (userPermissionReadId === id || userPermissions.value?.user_id === id) {
        userPermissionsError.value = apiErrorMessage(e as { message?: string; code?: unknown })
      }
      return false
    }
  }

  /** Resets the rules and route checks to the backend defaults. */
  async function resetRbac(): Promise<boolean> {
    try {
      await new RBACApi(apiConfig()).rbacResetPost()
      await reloadRules()
      return true
    } catch (e) {
      setError(e)
      return false
    }
  }

  return {
    presets,
    presetRules,
    matrix,
    routePolicies,
    kinds,
    loading,
    saving,
    error,
    loadRbac,
    ensurePresets,
    createPreset,
    updatePreset,
    deletePreset,
    myPermissions,
    permsLoaded,
    resetPermissions,
    can,
    perm,
    canOwn,
    loadMyPermissions,
    refreshPermissions,
    startPermissionSync,
    reloadRules,
    upsertRule,
    deleteRule,
    resetRbac,
    userPermissions,
    userPermissionsLoading,
    userPermissionsError,
    loadUserPermissions,
    saveUserPermissions,
  }
})

/** Filters accepted by the audit journal query. */
export interface AuditQueryFilters {
  limit?: number
  offset?: number
  userId?: number
  /** Login or full name (case-insensitive substring), resolved server-side. */
  user?: string
  entity?: string
  action?: string
  /** HTTP status group ("2xx"/"3xx"/"4xx"/"5xx") or an exact code. */
  status?: string
  from?: string
  to?: string
  search?: string
  /** Entity or actor id (matches the ID column: entity_id ?? actor_user_id). */
  id?: string
  /** Exact actor IP (e.g. 172.18.0.1). */
  ip?: string
}

/**
 * Audit journal store: reads the admin audit-log page (all CRUD mutations +
 * auth events) through the ERP API, which relays queries to the dedicated
 * auditlog service.
 */
export const useAuditStore = defineStore('audit', () => {
  const items = ref<DtoAuditEventView[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** The backend has no /audit/events route (audit.enabled=false in config):
   *  the page shows a help card instead of a raw 404 error. */
  const disabled = ref(false)

  async function load(filters: AuditQueryFilters = {}): Promise<boolean> {
    loading.value = true
    error.value = null
    try {
      const resp = await new AuditApi(apiConfig()).auditEventsGet(
        filters.limit,
        filters.offset,
        filters.userId,
        filters.user,
        filters.entity,
        filters.action,
        filters.status,
        filters.from,
        filters.to,
        filters.search,
        filters.id,
        filters.ip,
      )
      const data = resp.data?.data
      items.value = data?.items ?? []
      total.value = data?.total ?? 0
      // A successful load means the journal is reachable again (e.g. the
      // backend was restarted with audit.enabled=true) — drop the disabled state.
      disabled.value = false
      return true
    } catch (e: unknown) {
      if ((e as AxiosError | undefined)?.response?.status === 404) {
        // The backend does not register the audit route: treat it as "the
        // journal is disabled" rather than a real load error (raw "404" text).
        disabled.value = true
        error.value = null
      } else {
        disabled.value = false
        error.value = apiErrorMessage(e as { message?: string; code?: unknown })
      }
      return false
    } finally {
      loading.value = false
    }
  }

  return { items, total, loading, error, disabled, load }
})
