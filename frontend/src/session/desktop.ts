import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios'
import { ref } from 'vue'
import type { DtoUserInfo } from '@/api'
import { getApiUrl } from '@/config'
import routes from './apiRoutes.json'

export interface SessionState {
  server: string | null
  user: DtoUserInfo | null
  mode: 'signedOut' | 'online' | 'offline'
  persistent: boolean
  offlineAvailable: boolean
  needsLogin: boolean
  contextId: string
  revision: number
  expiresAt: number
  error?: { code?: string; message?: string }
}
export interface DesktopSession {
  status(): Promise<SessionState>
  selectServer(server: string): Promise<SessionState>
  login(username: string, password: string): Promise<SessionState>
  refresh(): Promise<SessionState>
  logout(): Promise<SessionState>
  enterOffline(username: string | null): Promise<SessionState>
  probe(): Promise<boolean>
  api(request: { operation: string; contextId: string; requestId: string; path?: Record<string, string>; query?: Record<string, string>; body?: unknown; key?: string; locale?: string; viewUser?: number }): Promise<{ status: number; data: unknown }>
  cancel(requestId: string): Promise<void>
  subscribe(listener: (state: SessionState) => void): () => void
}
export const desktopSession = typeof window !== 'undefined' ? window.erpDesktop?.session : undefined
export const desktopSessionState = ref<SessionState | null>(null)
function adopt(state: SessionState) {
  if (!desktopSessionState.value || state.revision >= desktopSessionState.value.revision) desktopSessionState.value = state
  return desktopSessionState.value!
}
const unsubscribe = desktopSession?.subscribe(adopt)
import.meta.hot?.dispose(() => unsubscribe?.())
let selecting: Promise<SessionState> | null = null
export async function prepareDesktopSession(): Promise<SessionState> {
  if (!desktopSession) throw new Error('SESSION_UNAVAILABLE')
  const server = getApiUrl()
  if (!server || !/^https?:\/\//.test(server)) return adopt(await desktopSession.status())
  selecting ??= desktopSession.selectServer(server).then(adopt).finally(() => { selecting = null })
  return selecting
}
export async function desktopAction(action: 'login' | 'refresh' | 'logout' | 'enterOffline', username?: string | null, password?: string): Promise<SessionState> {
  await prepareDesktopSession()
  const bridge = desktopSession!
  return adopt(await (action === 'login' ? bridge.login(username || '', password || '') : action === 'enterOffline' ? bridge.enterOffline(username || null) : bridge[action]()))
}

// Generated clients and the legacy outbox retain canonical remote URLs, but no
// renderer request can choose an arbitrary native URL, verb or auth header.
export const desktopSessionAdapter: AxiosAdapter = async config => {
  const state = await prepareDesktopSession()
  const base = state.server
  const requestId = crypto.randomUUID()
  const fail = (code: string) => new AxiosError(code, code, config)
  if (!base || !desktopSession) throw fail('ERR_NETWORK')
  const url = new URL(axios.getUri(config), base + '/')
  const root = new URL(base)
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname + '/')) throw fail('ERR_BAD_REQUEST')
  const routePath = url.pathname.slice(root.pathname.length)
  let path: Record<string, string> = {}
  const route = routes.find(item => {
    if (item.method !== (config.method || 'get').toUpperCase()) return false
    const names = [...item.path.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!)
    const match = new RegExp('^' + item.path.replace(/\{([^}]+)\}/g, (_, name: string) => (item.pathTypes as Record<string, string>)[name] === 'integer' ? '([1-9]\\d*)' : '([^/]+)') + '$').exec(routePath)
    if (!match) return false
    path = Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)]))
    return true
  })
  if (!route) throw fail('ERR_BAD_REQUEST')
  const abort = () => { void desktopSession.cancel(requestId).catch(() => {}) }
  config.signal?.addEventListener?.('abort', abort)
  try {
    if (config.signal?.aborted) throw new axios.CanceledError()
    const headers = AxiosHeaders.from(config.headers)
    const result = await desktopSession.api({
      operation: route.operation, contextId: state.contextId, requestId, path,
      query: Object.fromEntries(url.searchParams),
      body: typeof config.data === 'string' ? JSON.parse(config.data) as unknown : config.data,
      key: headers.get('Idempotency-Key') as string | undefined,
      locale: headers.get('Accept-Language') as string | undefined,
      viewUser: headers.get('X-View-User-ID') ? Number(headers.get('X-View-User-ID')) : undefined,
    })
    if (config.signal?.aborted || desktopSessionState.value?.contextId !== state.contextId) throw new axios.CanceledError('Session context changed', config)
    const response = { data: result.data, status: result.status, statusText: '', headers: new AxiosHeaders(), config }
    if (!config.validateStatus || config.validateStatus(result.status)) return response
    throw new AxiosError('Request failed', result.status >= 500 ? 'ERR_BAD_RESPONSE' : 'ERR_BAD_REQUEST', config, undefined, response)
  } catch (error) {
    if (desktopSessionState.value?.contextId !== state.contextId) throw new axios.CanceledError('Session context changed', config)
    if (axios.isAxiosError(error) || axios.isCancel(error)) throw error
    const message = error instanceof Error ? error.message : ''
    if (message === 'SESSION_CONTEXT_CHANGED') throw new axios.CanceledError(message, config)
    if (message.startsWith('SESSION_INVALID')) throw fail('ERR_BAD_REQUEST')
    throw fail('ERR_NETWORK')
  } finally { config.signal?.removeEventListener?.('abort', abort) }
}
