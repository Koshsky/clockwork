import type { ApplicationRuntime } from '@/platform/lifecycle'

export async function createPlatformRuntime(): Promise<ApplicationRuntime> {
  const { createWebRuntime } = await import('@/platform/web')
  return createWebRuntime()
}
