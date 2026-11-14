import { builtinModules } from 'node:module'

const nativeModules = new Set(builtinModules.map(name => name.replace(/^node:/, '')))
export function forbiddenRendererImport(source) {
  return source === 'electron' || source.startsWith('electron/') ||
    nativeModules.has(source.replace(/^node:/, '')) ||
    /(?:^|\/)desktop\/(?:main|preload|application|profile|protocol|service|ipc)\.[cm]?[jt]s(?:$|\?)/.test(source)
}

// Legacy cache/queue imports remain until the read/write adapters are migrated.
// Native modules must never enter either renderer, including dynamic chunks.
export function rendererPlatformBoundary() {
  return {
    name: 'renderer-platform-boundary',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, importer) {
      if (importer && forbiddenRendererImport(source)) this.error(`Native import in renderer: ${source} from ${importer}`)
      return null
    },
  }
}
