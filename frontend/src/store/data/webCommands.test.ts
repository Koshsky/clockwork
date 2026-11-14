import axios, { AxiosError, type AxiosRequestConfig, type InternalAxiosRequestConfig } from 'axios'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hasActiveMutations, mayApplyRead, readStamp } from '@/offline/mutationGuard'
const fake = vi.hoisted(() => ({ user: 7, server: '/api/v1', key: 0, enqueue: vi.fn(), refresh: vi.fn() }))
vi.mock('@/offline/cache', () => ({ currentUserId: () => fake.user }))
vi.mock('@/config', () => ({ getApiUrl: () => fake.server }))
vi.mock('@/offline/outbox', () => ({ createMutationKey: () => 'operation-' + ++fake.key, enqueueMutation: fake.enqueue }))
vi.mock('@/offline/sync', () => ({ scheduleDomainRefresh: fake.refresh }))
import { dismissUncertainCommand, resetWebCommands, retryUncertainCommand, runWebCommand, uncertainCommands, webPendingRefs } from './webCommands'
const originalAdapter = axios.defaults.adapter
const success = (config: InternalAxiosRequestConfig, data: unknown = { id: 42 }) => ({ config, data: { data }, status: 200, statusText: 'OK', headers: {} })
const refusal = (config: InternalAxiosRequestConfig, status: number) => new AxiosError('Server refusal', undefined, config, undefined, { ...success(config), status })
const options = () => ({
  key: ['task.create', { title: 'Original', process_id: 1 }], entity: 'task' as const, targetId: 7,
  call: vi.fn((request: AxiosRequestConfig) => axios.post('/api/v1/task', { title: 'Original', process_id: 1 }, request)),
  apply: vi.fn(), onError: vi.fn(),
})
beforeEach(() => {
  resetWebCommands(); vi.clearAllMocks(); fake.key = 0; fake.user = 7; fake.server = '/api/v1'
  vi.stubGlobal('indexedDB', { open: vi.fn(() => { throw new Error('No durable web writes') }) })
  axios.defaults.adapter = async config => success(config)
})
afterEach(() => {
  expect(hasActiveMutations()).toBe(false)
  expect(fake.enqueue).not.toHaveBeenCalled()
  expect(indexedDB.open).not.toHaveBeenCalled()
  resetWebCommands(); axios.defaults.adapter = originalAdapter; vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('confirms the DTO once and refreshes the affected domain without writing an outbox', async () => {
  const command = options()
  expect(await runWebCommand(command)).toMatchObject({ status: 'confirmed', data: { id: 42 }, operationId: 'operation-1' })
  expect(command.apply).toHaveBeenCalledExactlyOnceWith({ id: 42 })
  expect(fake.refresh).toHaveBeenCalledExactlyOnceWith(['task'])
  expect(uncertainCommands.value).toEqual([])
})
it('keeps an online pending mark and protects GETs only until the write settles', async () => {
  let release!: () => void
  axios.defaults.adapter = config => new Promise<ReturnType<typeof success>>(resolve => { release = () => resolve(success(config)) })
  const stamp = readStamp(), command = options(), result = runWebCommand(command)
  expect(hasActiveMutations()).toBe(true)
  expect(webPendingRefs.value.has('task:7')).toBe(true)
  await vi.waitFor(() => expect(command.call).toHaveBeenCalledOnce())
  expect(command.apply).not.toHaveBeenCalled()
  release(); await result
  expect(webPendingRefs.value.size).toBe(0)
  expect(mayApplyRead(stamp)).toBe(false)
})
it('deduplicates simultaneous clicks through confirmation and local apply', async () => {
  let release!: () => void
  const send = vi.fn((config: InternalAxiosRequestConfig) => new Promise<ReturnType<typeof success>>(resolve => { release = () => resolve(success(config)) }))
  axios.defaults.adapter = send
  const command = options(), first = runWebCommand(command), duplicate = runWebCommand({ ...command, key: ['task.create', { process_id: 1, title: 'Original' }] })
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce())
  release()
  expect((await Promise.all([first, duplicate])).map(result => result.status)).toEqual(['confirmed', 'confirmed'])
  expect(command.apply).toHaveBeenCalledOnce()
})
it.each([400, 401, 403, 404, 409, 422])('rejects HTTP %s without enqueue, apply or an automatic retry', async status => {
  axios.defaults.adapter = async config => { throw refusal(config, status) }
  const command = options()
  expect((await runWebCommand(command)).status).toBe(status === 409 ? 'conflict' : 'rejected')
  expect(command.apply).not.toHaveBeenCalled()
  expect(command.onError).toHaveBeenCalledOnce()
  expect(uncertainCommands.value).toEqual([])
})
it.each(['ERR_NETWORK', 'ECONNABORTED', 500, 503])('keeps %s as an explicitly unknown result, never queued or confirmed', async failure => {
  axios.defaults.adapter = async config => { throw typeof failure === 'number' ? refusal(config, failure) : new AxiosError('Interrupted', failure, config) }
  const command = options()
  expect(await runWebCommand(command)).toMatchObject({ status: 'unknown', operationId: 'operation-1' })
  expect(command.apply).not.toHaveBeenCalled()
  expect(uncertainCommands.value).toMatchObject([{ id: 'operation-1', retryable: true, busy: false }])
})
it('replays the exact request with its original key after a lost response, even if editor input changed', async () => {
  const payload = { title: 'Original' }, sent: Array<{ key: unknown; data: unknown }> = []
  axios.defaults.adapter = async config => {
    sent.push({ key: config.headers.get('Idempotency-Key'), data: JSON.parse(config.data) })
    if (sent.length === 1) throw new AxiosError('Lost response', 'ERR_NETWORK', config)
    return success(config)
  }
  const command = { ...options(), call: (request: AxiosRequestConfig) => axios.post('/api/v1/task', payload, request) }
  await runWebCommand(command)
  payload.title = 'Changed in editor'
  await retryUncertainCommand('operation-1')
  expect(sent).toEqual([{ key: 'operation-1', data: { title: 'Original' } }, { key: 'operation-1', data: { title: 'Original' } }])
  expect(command.apply).toHaveBeenCalledOnce()
  expect(uncertainCommands.value).toEqual([])
})
it('retains the unknown operation key after dismissing its notice and pressing save again', async () => {
  const keys: unknown[] = []
  axios.defaults.adapter = async config => {
    keys.push(config.headers.get('Idempotency-Key'))
    if (keys.length === 1) throw new AxiosError('Lost', 'ERR_NETWORK', config)
    return success(config)
  }
  const command = options(); await runWebCommand(command)
  dismissUncertainCommand('operation-1')
  expect(uncertainCommands.value).toEqual([])
  expect((await runWebCommand(command)).status).toBe('confirmed')
  expect(keys).toEqual(['operation-1', 'operation-1'])
})
it('does not resend after local apply fails following a confirmed HTTP response', async () => {
  const command = options(); command.apply.mockRejectedValue(new Error('Local projection failed'))
  expect((await runWebCommand(command)).status).toBe('unknown')
  expect(uncertainCommands.value[0]?.retryable).toBe(false)
  await retryUncertainCommand('operation-1'); await runWebCommand(command)
  expect(command.call).toHaveBeenCalledOnce()
})
it('does not apply an older response over a later edit of the same task', async () => {
  let release!: () => void
  axios.defaults.adapter = config => JSON.parse(config.data).title === 'Old'
    ? new Promise(resolve => { release = () => resolve(success(config, { title: 'Old' })) })
    : Promise.resolve(success(config, { title: 'New' }))
  let title = 'Original'
  const command = (value: string) => ({ ...options(), key: ['task.update', 7, value], call: (request: AxiosRequestConfig) => axios.put('/api/v1/task/7', { title: value }, request), apply: (dto: { title?: string } | null) => { title = dto?.title ?? '' } })
  const old = runWebCommand(command('Old')); await vi.waitFor(() => expect(release).toBeDefined())
  await runWebCommand(command('New')); release(); await old
  expect(title).toBe('New')
})
it('never retries an uncertain write after a newer write to its target', async () => {
  let calls = 0
  axios.defaults.adapter = async config => { if (++calls === 1) throw new AxiosError('Lost', 'ERR_NETWORK', config); return success(config) }
  await runWebCommand(options()); await runWebCommand({ ...options(), key: ['task.update', 7, 'new'] })
  await retryUncertainCommand('operation-1')
  expect(calls).toBe(2)
  expect(uncertainCommands.value[0]?.retryable).toBe(false)
})
it('refuses unsafe replay beyond the backend receipt retention window', async () => {
  const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  axios.defaults.adapter = async config => { throw new AxiosError('Lost', 'ERR_NETWORK', config) }
  const command = options(); await runWebCommand(command)
  clock.mockReturnValue(now + 24 * 60 * 60 * 1000)
  await retryUncertainCommand('operation-1'); await runWebCommand(command)
  expect(command.call).toHaveBeenCalledOnce(); expect(uncertainCommands.value[0]?.retryable).toBe(false)
})
it('never retains or automatically replays a password or one-time-secret command', async () => {
  axios.defaults.adapter = async config => { throw new AxiosError('Lost', 'ERR_NETWORK', config) }
  const command = { ...options(), key: ['account.password', 7], sensitive: true }
  expect((await runWebCommand(command)).status).toBe('unknown')
  expect(uncertainCommands.value[0]?.retryable).toBe(false)
  await retryUncertainCommand('operation-1')
  expect(command.call).toHaveBeenCalledOnce()
  expect(JSON.stringify(uncertainCommands.value)).not.toContain('Original')
})
it.each(['account', 'server', 'logout'])('does not apply or retry a previous %s operation', async change => {
  let release!: () => void
  axios.defaults.adapter = config => new Promise<ReturnType<typeof success>>(resolve => { release = () => resolve(success(config)) })
  const command = options(), result = runWebCommand(command)
  await vi.waitFor(() => expect(release).toBeDefined())
  if (change === 'account') fake.user = 8
  if (change === 'server') fake.server = '/different-api'
  resetWebCommands(); release(); await result
  expect(command.apply).not.toHaveBeenCalled(); expect(command.onError).not.toHaveBeenCalled()
  expect(uncertainCommands.value).toEqual([]); expect(webPendingRefs.value.size).toBe(0)
})
it('rejects a 2xx domain error instead of applying it as saved', async () => {
  axios.defaults.adapter = async config => ({ ...success(config), data: { error: { code: 'CONFLICT', message: 'Changed by another user' } } })
  const command = options()
  expect((await runWebCommand(command)).status).toBe('conflict')
  expect(command.apply).not.toHaveBeenCalled()
})
it('releases a synchronous failure so a corrected attempt can proceed', async () => {
  const command = options(); command.call.mockImplementationOnce(() => { throw new Error('Invalid input') })
  expect((await runWebCommand(command)).status).toBe('rejected')
  expect((await runWebCommand(command)).status).toBe('confirmed')
})
it('allows a new password attempt only after the user explicitly checked the unknown result', async () => {
  axios.defaults.adapter = async config => { throw new AxiosError('Lost', 'ERR_NETWORK', config) }
  const command = { ...options(), key: ['account.password', 7], sensitive: true }
  await runWebCommand(command); await runWebCommand(command)
  expect(command.call).toHaveBeenCalledOnce()
  dismissUncertainCommand('operation-1')
  axios.defaults.adapter = async config => success(config)
  expect((await runWebCommand(command)).status).toBe('confirmed')
  expect(command.call).toHaveBeenCalledTimes(2)
})
it('does not suppress unrelated assignment confirmations on the same task', async () => {
  let release!: () => void
  axios.defaults.adapter = config => config.url === '/assignment/first'
    ? new Promise(resolve => { release = () => resolve(success(config)) }) : Promise.resolve(success(config))
  const first = { ...options(), entity: 'assignment' as const, key: ['assignment', 7, 11], target: ['assignment', 7, 11], call: (request: AxiosRequestConfig) => axios.post('/assignment/first', {}, request) }
  const second = { ...options(), entity: 'assignment' as const, key: ['assignment', 7, 12], target: ['assignment', 7, 12] }
  const pending = runWebCommand(first); await vi.waitFor(() => expect(release).toBeDefined())
  await runWebCommand(second); release(); await pending
  expect(first.apply).toHaveBeenCalledOnce(); expect(second.apply).toHaveBeenCalledOnce()
})
it('lets the original editor acknowledge a manual retry without submitting a duplicate creation', async () => {
  let calls = 0
  axios.defaults.adapter = async config => { if (++calls === 1) throw new AxiosError('Lost', 'ERR_NETWORK', config); return success(config) }
  const command = options(); await runWebCommand(command); await retryUncertainCommand('operation-1')
  expect((await runWebCommand(command)).status).toBe('confirmed')
  expect(calls).toBe(2); expect(command.apply).toHaveBeenCalledOnce()
})
it('releases a faulty UI error handler without hanging or forgetting an unknown operation', async () => {
  axios.defaults.adapter = async config => { throw new AxiosError('Lost', 'ERR_NETWORK', config) }
  const command = options(); command.onError.mockImplementationOnce(() => { throw new Error('Broken error view') })
  await expect(runWebCommand(command)).rejects.toThrow('Broken error view')
  expect(webPendingRefs.value.size).toBe(0)
  expect(uncertainCommands.value).toMatchObject([{ id: 'operation-1', retryable: true }])
})
it('allows an explicitly checked result to release a command that cannot be safely replayed', async () => {
  const command = options(); command.apply.mockRejectedValueOnce(new Error('Local apply failed'))
  await runWebCommand(command)
  expect(uncertainCommands.value[0]?.retryable).toBe(false)
  dismissUncertainCommand('operation-1')
  expect((await runWebCommand(command)).status).toBe('confirmed')
  expect(command.call).toHaveBeenCalledTimes(2)
})
