import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ desktop: false, web: vi.fn(), native: vi.fn() }))
vi.mock('./context', () => ({ platformCapabilities: { get offlineBootstrap() { return fake.desktop } } }))
vi.mock('./web', () => ({ createWebRuntime: fake.web }))
vi.mock('./desktop', () => ({ createDesktopRuntime: fake.native }))
import { createPlatformRuntime } from './select'
beforeEach(() => { vi.resetAllMocks(); fake.desktop = false })
it('composes web services without constructing a desktop runtime', async () => {
  fake.web.mockReturnValue({ kind: 'web' })
  expect(await createPlatformRuntime()).toEqual({ kind: 'web' })
  expect(fake.web).toHaveBeenCalledOnce()
  expect(fake.native).not.toHaveBeenCalled()
})
it('composes the legacy desktop adapter only with its platform capability', async () => {
  fake.desktop = true; fake.native.mockReturnValue({ kind: 'desktop' })
  expect(await createPlatformRuntime()).toEqual({ kind: 'desktop' })
  expect(fake.native).toHaveBeenCalledOnce()
  expect(fake.web).not.toHaveBeenCalled()
})
