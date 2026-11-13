import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { AxiosHeaders, type InternalAxiosRequestConfig } from 'axios'
const fake = vi.hoisted(() => ({ selectServer: vi.fn(), login: vi.fn(), api: vi.fn(), cancel: vi.fn(), status: vi.fn(), subscribe: vi.fn(), server: 'https://erp.example/api/v1' }))
vi.mock('@/config', () => ({ getApiUrl: () => fake.server }))
const state = { server: 'https://erp.example/api/v1', user: { id: 7, username: 'u' }, mode: 'online', persistent: true, offlineAvailable: true, needsLogin: false, contextId: 'ctx', revision: 1, expiresAt: Date.now() + 60000 }
let session: typeof import('./desktop')
beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks()
  fake.server = state.server
  fake.login.mockResolvedValue(state)
  fake.cancel.mockResolvedValue(undefined); fake.selectServer.mockResolvedValue(state); fake.api.mockResolvedValue({ status: 200, data: { data: { id: 1 }, error: {} } })
  vi.stubGlobal('window', { erpDesktop: { session: fake } })
  session = await import('./desktop')
})
afterEach(() => vi.unstubAllGlobals())
function config(patch: object = {}): InternalAxiosRequestConfig {
  return { url: fake.server + '/project/7', method: 'put', data: '{"name":"Test"}', headers: new AxiosHeaders({ Authorization: 'Bearer renderer-must-be-ignored', 'Idempotency-Key': 'stable-operation', 'Accept-Language': 'en', 'X-View-User-ID': '7' }), validateStatus: code => code >= 200 && code < 300, ...patch }
}
it('maps generated client requests to finite operations and strips renderer credentials', async () => {
  const response = await session.desktopSessionAdapter(config())
  expect(response.status).toBe(200)
  expect(fake.api).toHaveBeenCalledWith(expect.objectContaining({ operation: 'PUT /project/{id}', path: { id: '7' }, body: { name: 'Test' }, key: 'stable-operation', locale: 'en', viewUser: 7, contextId: 'ctx' }))
  expect(JSON.stringify(fake.api.mock.calls)).not.toContain('renderer-must-be-ignored')
})
it.each(['https://evil.example/api/v1/project', 'https://erp.example/api/v1/auth/refresh', 'https://erp.example/api/v1/../auth/login', 'file:///etc/passwd', 'https://erp.example/other/project'])('denies arbitrary URL or auth bypass: %s', async url => {
  await expect(session.desktopSessionAdapter(config({ url, method: 'get' }))).rejects.toMatchObject({ code: 'ERR_BAD_REQUEST' })
  expect(fake.api).not.toHaveBeenCalled()
})
it('preserves HTTP refusal as a response, so it cannot become an offline queued edit', async () => {
  fake.api.mockResolvedValue({ status: 403, data: { error: { code: 'FORBIDDEN' } } })
  await expect(session.desktopSessionAdapter(config())).rejects.toMatchObject({ response: { status: 403 } })
})
it('preserves backend 503 rather than classifying it as an absent network response', async () => {
  fake.api.mockResolvedValue({ status: 503, data: {} })
  await expect(session.desktopSessionAdapter(config())).rejects.toMatchObject({ response: { status: 503 } })
})
it('leaves transport failure response-less for the existing durable outbox', async () => {
  fake.api.mockRejectedValue(new Error('SESSION_UNAVAILABLE'))
  const result = await session.desktopSessionAdapter(config()).catch(error => error)
  expect(result.code).toBe('ERR_NETWORK')
  expect(result.response).toBeUndefined()
})
it('does not dispatch an aborted read', async () => {
  const controller = new AbortController(); controller.abort()
  await expect(session.desktopSessionAdapter(config({ signal: controller.signal }))).rejects.toMatchObject({ code: 'ERR_CANCELED' })
  expect(fake.api).not.toHaveBeenCalled()
})
it('discards a result after cancellation and forwards only its opaque request id', async () => {
  const controller = new AbortController(); let finish!: (result: unknown) => void
  fake.api.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = session.desktopSessionAdapter(config({ signal: controller.signal }))
  await vi.waitFor(() => expect(fake.api).toHaveBeenCalledTimes(1))
  controller.abort(); finish({ status: 200, data: {} })
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' })
  expect(fake.cancel).toHaveBeenCalledWith(fake.api.mock.calls[0]![0].requestId)
})

it('never applies a late IPC state over a newer login or logout notification', async () => {
  const listener = fake.subscribe.mock.calls[0]![0]
  listener({ ...state, user: { id: 8, username: 'another' }, contextId: 'new-context', revision: 10 })
  fake.selectServer.mockResolvedValue(state)
  expect((await session.prepareDesktopSession()).user?.id).toBe(8)
  expect(session.desktopSessionState.value?.contextId).toBe('new-context')
})
it('treats stale native account results as cancellation rather than an offline queued edit', async () => {
  fake.api.mockRejectedValue(new Error('SESSION_CONTEXT_CHANGED'))
  await expect(session.desktopSessionAdapter(config())).rejects.toMatchObject({ code: 'ERR_CANCELED' })
})
it('maps string preset identifiers without losing role management operations', async () => {
  await session.desktopSessionAdapter(config({ url: fake.server + '/rbac/presets/custom_role', method: 'put' }))
  expect(fake.api).toHaveBeenCalledWith(expect.objectContaining({ operation: 'PUT /rbac/presets/{tag}', path: { tag: 'custom_role' } }))
})
it('allows an unconfigured desktop to boot before a server is selected', async () => {
  fake.server = '/api/v1'
  fake.status.mockResolvedValue({ ...state, server: null, mode: 'signedOut', user: null })
  expect((await session.prepareDesktopSession()).mode).toBe('signedOut')
  expect(fake.selectServer).not.toHaveBeenCalled()
  fake.server = state.server
})
it('routes server diagnostics through main without a renderer request carrying credentials', async () => {
  const probe = vi.fn(async () => true)
  Object.assign(fake, { probe })
  const { probeServerLogin } = await import('@/store/data/pageReads')
  expect(await probeServerLogin(fake.server)).toBe(true)
  expect(probe).toHaveBeenCalledTimes(1)
  expect(fake.api).not.toHaveBeenCalled()
})
it('does not turn a late transport error from another account into a queued mutation', async () => {
  let reject!: (error: Error) => void
  fake.api.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
  const pending = session.desktopSessionAdapter(config())
  await vi.waitFor(() => expect(fake.api).toHaveBeenCalled())
  fake.subscribe.mock.calls[0]![0]({ ...state, contextId: 'another-account', revision: 10 })
  reject(new Error('SESSION_UNAVAILABLE'))
  await expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' })
})

it('selects the new server before forwarding login and cancels the old preparation', async () => {
  let finishOld!: (value: typeof state) => void
  const next = { ...state, server: 'https://second.example/api/v1', contextId: 'second', revision: 2 }
  fake.selectServer.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValueOnce(next)
  fake.login.mockResolvedValue(next)
  const old = session.prepareDesktopSession().catch(error => error)
  fake.server = next.server
  const login = session.desktopAction('login', 'user', 'password')
  try {
    await vi.waitFor(() => expect(fake.selectServer).toHaveBeenCalledTimes(2))
    expect(await login).toMatchObject({ server: next.server })
    expect(fake.login).toHaveBeenCalledWith('user', 'password', next.server)
  } finally {
    finishOld(state)
    await login.catch(() => {})
  }
  expect(await old).toMatchObject({ message: 'SESSION_CONTEXT_CHANGED' })
  expect(session.desktopSessionState.value?.server).toBe(next.server)
})

it('does not let an old server reply release the current selection flight', async () => {
  let finishOld!: (value: typeof state) => void, finishNew!: (value: typeof state) => void
  const next = { ...state, server: 'https://second.example/api/v1', contextId: 'second', revision: 2 }
  fake.selectServer.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
  const old = session.prepareDesktopSession().catch(error => error)
  fake.server = next.server
  const current = session.prepareDesktopSession()
  let joined: Promise<unknown> | undefined
  try {
    await vi.waitFor(() => expect(fake.selectServer).toHaveBeenCalledTimes(2))
    finishOld(state)
    expect(await old).toMatchObject({ message: 'SESSION_CONTEXT_CHANGED' })
    joined = session.prepareDesktopSession()
    expect(fake.selectServer).toHaveBeenCalledTimes(2)
  } finally {
    finishOld(state)
    finishNew?.(next)
    await Promise.all([old, current, joined])
  }
})

it('does not forward credentials when the native state belongs to another server', async () => {
  fake.selectServer.mockResolvedValue({ ...state, server: 'https://wrong.example/api/v1' })
  await expect(session.desktopAction('login', 'user', 'password')).rejects.toMatchObject({ message: 'SESSION_CONTEXT_CHANGED' })
  expect(fake.login).not.toHaveBeenCalled()
})

it('does not log in when another window selected a different server after the reply was sent', async () => {
  fake.subscribe.mock.calls[0]![0]({ ...state, server: 'https://second.example/api/v1', revision: 10 })
  await expect(session.desktopAction('login', 'user', 'password')).rejects.toMatchObject({ message: 'SESSION_CONTEXT_CHANGED' })
  expect(fake.login).not.toHaveBeenCalled()
})
