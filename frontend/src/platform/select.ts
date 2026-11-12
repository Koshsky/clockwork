import { platformCapabilities } from './context'
import type { ApplicationRuntime } from './lifecycle'

export async function createPlatformRuntime(): Promise<ApplicationRuntime> {
  if (platformCapabilities.offlineBootstrap) {
    const { createDesktopRuntime } = await import('./desktop')
    return createDesktopRuntime()
  }
  const { createWebRuntime } = await import('./web')
  return createWebRuntime()
}
