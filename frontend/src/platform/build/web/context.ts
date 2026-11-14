import type { RuntimeCapabilities } from '@/platform/capabilities'

export const platformCapabilities: Readonly<RuntimeCapabilities> = Object.freeze({
  kind: 'web', serverSelection: false, offlineBootstrap: false,
  optionalStorage: true, bootstrapBoundMs: 0, sessionRestoreBoundMs: 2500,
})
