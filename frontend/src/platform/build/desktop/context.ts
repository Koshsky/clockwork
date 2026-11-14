import type { RuntimeCapabilities } from '@/platform/capabilities'

export const platformCapabilities: Readonly<RuntimeCapabilities> = Object.freeze({
  kind: 'desktop', serverSelection: true, offlineBootstrap: true,
  optionalStorage: false, bootstrapBoundMs: 4000, sessionRestoreBoundMs: 2500,
})
