export interface RuntimeCapabilities {
  kind: 'web' | 'desktop'
  serverSelection: boolean
  offlineBootstrap: boolean
  optionalStorage: boolean
  bootstrapBoundMs: number
  sessionRestoreBoundMs: number
}

export function detectCapabilities(bridge: { isElectron?: unknown } | null | undefined): Readonly<RuntimeCapabilities> {
  const desktop = bridge?.isElectron === true
  return Object.freeze({
    kind: desktop ? 'desktop' : 'web',
    serverSelection: desktop,
    offlineBootstrap: desktop,
    optionalStorage: !desktop,
    bootstrapBoundMs: desktop ? 4000 : 0,
    sessionRestoreBoundMs: 2500,
  })
}
