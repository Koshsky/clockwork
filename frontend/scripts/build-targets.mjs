import path from 'node:path'

export function buildTarget(command, requested = process.env.ERP_BUILD_TARGET) {
  const target = requested || (command === 'build' ? 'web' : 'auto')
  if (!['web', 'desktop', 'auto'].includes(target) || command === 'build' && target === 'auto') throw new Error('ERP_BUILD_TARGET must be web or desktop for production builds')
  return target
}
export function webApiPath(requested) {
  const value = requested || '/api/v1'
  if (!/^\/api\/v1\/?$/.test(value)) throw new Error('Web renderer requires the same-origin /api/v1 API base')
  return '/api/v1'
}
const webReplacements = {
  'platform/context': 'context', 'platform/select': 'select',
  'offline/db': 'db', 'offline/outbox': 'outbox', 'offline/desktopQueue': 'desktopQueue',
  'session/desktop': 'session', 'store/data/applicationPorts': 'applicationPorts',
  'platform/cacheStore': 'cacheStore', 'platform/legacyRead': 'legacyRead', 'offline/connection': 'connection',
}
const desktopReplacements = { 'platform/context': 'context', 'platform/select': 'select' }
const normalized = value => path.posix.normalize(value.replaceAll('\\', '/').split('?')[0])
export function rendererReplacement(target, root, source, importer) {
  if (target === 'auto' || source.startsWith('\0')) return null
  const base = normalized(root), requested = source.startsWith('@/') ? base + '/src/' + source.slice(2)
    : source.startsWith('.') && importer ? path.posix.normalize(path.posix.dirname(normalized(importer)) + '/' + source.replaceAll('\\', '/'))
      : normalized(source)
  const absolute = normalized(requested).replace(/\.ts$/, '')
  const entries = target === 'web' ? webReplacements : desktopReplacements
  const relative = absolute.startsWith(base + '/src/') ? absolute.slice((base + '/src/').length) : null
  return relative && entries[relative] ? base + '/src/platform/build/' + target + '/' + entries[relative] + '.ts' : null
}
export function inspectRendererModules(target, root, ids) {
  const base = normalized(root) + '/', modules = [...new Set(ids.map(normalized).filter(id => id.startsWith(base)).map(id => id.slice(base.length)))].sort()
  const prohibited = target === 'web' ? ['src/platform/build/desktop/', 'src/platform/desktop.ts', 'src/offline/db.ts', 'src/offline/outbox.ts', 'src/offline/desktopQueue.ts', 'src/offline/session.ts', 'src/offline/nativeEvents.ts', 'src/session/desktop.ts', 'src/store/data/applicationPorts.ts'] : ['src/platform/build/web/', 'src/platform/web.ts']
  const invalid = modules.filter(id => prohibited.some(candidate => candidate.endsWith('/') ? id.startsWith(candidate) : id === candidate))
  if (invalid.length) throw new Error('Wrong ' + target + ' renderer composition: ' + invalid.join(', '))
  return modules
}
export function rendererBuildComposition(target, version) {
  let root
  return {
    name: 'renderer-build-composition', enforce: 'pre',
    configResolved(config) { root = config.root },
    resolveId(source, importer) { return rendererReplacement(target, root, source, importer) },
    generateBundle(_options, bundle) {
      const modules = inspectRendererModules(target, root, [...this.getModuleIds()])
      const entry = Object.values(bundle).find(item => item.type === 'chunk' && item.isEntry)
      if (!entry || !modules.includes('src/main.ts')) throw new Error('Renderer entry is missing')
      const runtime = target === 'web' ? 'src/platform/web.ts' : 'src/platform/desktop.ts'
      if (!modules.includes(runtime)) throw new Error('Renderer runtime is missing: ' + runtime)
      this.emitFile({ type: 'asset', fileName: 'build-target.json', source: JSON.stringify({ protocol: 1, target, version, entry: entry.fileName, modules }, null, 2) + '\n' })
    },
  }
}
