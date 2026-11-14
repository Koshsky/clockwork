import type { ApplicationRuntime } from '@/platform/lifecycle'

export async function createPlatformRuntime(): Promise<ApplicationRuntime> {
  const { createDesktopRuntime } = await import('@/platform/desktop')
  return createDesktopRuntime()
}
