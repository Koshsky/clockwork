// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick, reactive } from 'vue'

const fake = vi.hoisted(() => ({
  create: vi.fn(), start: vi.fn(), stop: vi.fn(), mount: vi.fn(), dispose: vi.fn(),
  ports: vi.fn(), auth: { isAuthenticated: false, sessionMode: 'online' },
}))
vi.mock('vue', async original => ({
  ...await original<typeof import('vue')>(),
  createApp: () => ({ use() {}, mount: fake.mount, onUnmount: (dispose: () => void) => { fake.dispose.mockImplementation(dispose) } }),
}))
vi.mock('pinia', () => ({ createPinia: () => ({}), setActivePinia() {}, disposePinia: vi.fn() }))
vi.mock('./App.vue', () => ({ default: {} }))
vi.mock('./router', () => ({ default: { currentRoute: { value: { name: 'login', meta: {}, query: {} } }, push: vi.fn() } }))
vi.mock('./http', () => ({ setupHttp: vi.fn() }))
vi.mock('./theme', () => ({ initTheme: vi.fn() }))
vi.mock('./settings', async () => ({ uiFontSize: (await import('vue')).ref('default'), applyUiSize: vi.fn() }))
vi.mock('./store', () => ({ useAuthStore: () => fake.auth }))
vi.mock('./i18n', () => ({ i18n: {} }))
vi.mock('./store/data/applicationPorts', () => ({ stopApplicationPorts: fake.ports }))
vi.mock('./platform/context', () => ({ platformCapabilities: { kind: 'web', bootstrapBoundMs: 0 } }))
vi.mock('./platform/select', () => ({ createPlatformRuntime: fake.create }))

beforeEach(() => {
  vi.clearAllMocks()
  fake.auth = reactive({ isAuthenticated: false, sessionMode: 'online' })
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
  window.dispatchEvent(new PageTransitionEvent('pagehide'))
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  await nextTick()
  expect(fake.create).toHaveBeenCalledOnce()
})
