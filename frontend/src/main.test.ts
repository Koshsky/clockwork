// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

const fake = vi.hoisted(() => ({
  create: vi.fn(), start: vi.fn(), stop: vi.fn(), mount: vi.fn(), dispose: vi.fn(),
  ports: vi.fn(), auth: { isAuthenticated: false, sessionMode: 'online', user: undefined as { id: number } | undefined },
  kind: 'web', epoch: 'initial', stopEpoch: vi.fn(), stopRouter: vi.fn(), info: vi.fn(),
  stopBranding: vi.fn(),
}))
vi.mock('vue', async original => ({
  ...await original<typeof import('vue')>(),
  createApp: () => ({ config: {}, use() {}, mount: fake.mount, onUnmount: (dispose: () => void) => { fake.dispose.mockImplementation(dispose) } }),
}))
vi.mock('pinia', () => ({ createPinia: () => ({}), setActivePinia() {}, disposePinia: vi.fn() }))
vi.mock('./App.vue', () => ({ default: {} }))
vi.mock('./router', () => ({ default: { currentRoute: { value: { name: 'login', meta: {}, query: {} } }, onError: () => fake.stopRouter, push: vi.fn() } }))
vi.mock('./sessionSync', () => ({ sessionEpoch: () => fake.epoch, subscribeEpoch: () => fake.stopEpoch }))
vi.mock('./store/data/pageReads', () => ({ loadBackendInfo: fake.info }))
vi.mock('./http', () => ({ setupHttp: vi.fn() }))
vi.mock('./theme', () => ({ initTheme: vi.fn() }))
vi.mock('./branding', () => ({ initBranding: () => fake.stopBranding }))
vi.mock('./settings', async () => ({ uiFontSize: (await import('vue')).ref('default'), applyUiSize: vi.fn() }))
vi.mock('./store', () => ({ useAuthStore: () => fake.auth }))
vi.mock('./i18n', () => ({ i18n: {} }))
vi.mock('./store/data/applicationPorts', () => ({ stopApplicationPorts: fake.ports }))
vi.mock('./platform/context', () => ({ platformCapabilities: { get kind() { return fake.kind }, bootstrapBoundMs: 0 } }))
vi.mock('./platform/select', () => ({ createPlatformRuntime: fake.create }))

beforeEach(() => {
  vi.clearAllMocks()
  fake.kind = 'web'; fake.epoch = 'initial'
  fake.auth = reactive({ isAuthenticated: false, sessionMode: 'online', user: undefined })
  fake.info.mockResolvedValue({ version: '1.6.0' })
  fake.create.mockImplementation(async () => ({ start: fake.start, stop: fake.stop }))
  fake.start.mockResolvedValue(undefined)
})
afterEach(() => { fake.dispose(); vi.restoreAllMocks() })
async function boot() { vi.resetModules(); await import('./main') }

it('mounts web UI even while platform initialization is still pending', async () => {
  let finish!: () => void
  fake.start.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  try { await boot(); expect(fake.mount).toHaveBeenCalledExactlyOnceWith('#app') }
  finally { finish() }
})
it('pauses on pagehide and resumes only when restored from the back/forward cache', async () => {
  await boot()
  window.dispatchEvent(new PageTransitionEvent('pagehide'))
  expect(fake.stop).toHaveBeenCalledOnce()
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: false }))
  expect(fake.create).toHaveBeenCalledOnce()
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await nextTick()
  expect(fake.create).toHaveBeenCalledTimes(2)
  expect(fake.start).toHaveBeenCalledTimes(2)
})
it('unmount releases ports, stops services and detaches page lifecycle handlers once', async () => {
  await boot()
  fake.dispose(); fake.dispose()
  expect(fake.stop).toHaveBeenCalledOnce()
  expect(fake.ports).toHaveBeenCalledOnce()
  expect(fake.stopBranding).toHaveBeenCalledOnce()
  window.dispatchEvent(new PageTransitionEvent('pagehide'))
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await nextTick()
  expect(fake.create).toHaveBeenCalledOnce()
})

it('loads backend metadata only when the panel is explicitly opened and detaches hooks on unmount', async () => {
  await boot()
  const diagnostics = await import('./diagnostics/web')
  expect(fake.info).not.toHaveBeenCalled()
  diagnostics.openDiagnostics(); await nextTick(); await nextTick()
  expect(fake.info).toHaveBeenCalledOnce()
  expect(diagnostics.webDiagnostics.snapshot().backend_version).toBe('1.6.0')
  fake.dispose()
  expect(fake.stopRouter).toHaveBeenCalledOnce(); expect(fake.stopEpoch).toHaveBeenCalledOnce()
})
it('closes diagnostics, aborts metadata and rejects its late result when identity changes', async () => {
  let finish!: (value: { version: string }) => void
  fake.info.mockReturnValue(new Promise(resolve => { finish = resolve }))
  await boot()
  const diagnostics = await import('./diagnostics/web')
  diagnostics.reportWebError('pdf'); diagnostics.openDiagnostics(); await nextTick()
  const signal = fake.info.mock.calls[0]![0] as AbortSignal
  fake.auth.user = { id: 2 }; await nextTick()
  expect(signal.aborted).toBe(true); expect(diagnostics.diagnosticsOpen.value).toBe(false)
  finish({ version: '1.5.0' }); await nextTick(); await nextTick()
  expect(diagnostics.webDiagnostics.snapshot()).toMatchObject({ backend_version: 'unknown', records: [] })
})
it('does not install a web history or metadata lookup in the desktop runtime', async () => {
  fake.kind = 'desktop'; await boot()
  const diagnostics = await import('./diagnostics/web')
  diagnostics.openDiagnostics(); diagnostics.reportWebError('pdf'); await nextTick()
  expect(diagnostics.diagnosticsOpen.value).toBe(false)
  expect(diagnostics.webDiagnostics.snapshot().records).toEqual([])
  expect(fake.info).not.toHaveBeenCalled()
})
