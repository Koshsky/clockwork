import { expect, it } from 'vitest'
import { forbiddenRendererImport } from '../../scripts/platform-boundaries.mjs'
const files = import.meta.glob(['../main.ts', './web.ts', './select.ts', './cacheStore.ts', '../offline/outbox.ts', '../views/SystemQueuePage.vue', '../../vite.config.ts'], { eager: true, query: '?raw', import: 'default' })
const source = (file: string) => files[file] as string
it.each(['electron', 'electron/main', 'node:fs', 'fs/promises', '../desktop/preload.cjs', '/app/desktop/main.js', '../desktop/service.cjs', '../desktop/application.cjs', '../desktop/ipc.cjs'])('blocks native renderer dependency %s', id => { expect(forbiddenRendererImport(id)).toBe(true) })
it.each(['vue', '../offline/cache', './desktop', './context', '@/store'])('permits renderer module %s', id => { expect(forbiddenRendererImport(id)).toBe(false) })
it('keeps bootstrap selection separate from the common entrypoint', () => {
  const main = source('../main.ts')
  expect(main).not.toMatch(/from ['"].*offline\//)
  expect(main).toContain('createPlatformRuntime')
  expect(main).toContain("addEventListener('pagehide'")
  expect(main).toContain("addEventListener('pageshow'")
  expect(main).toContain('import.meta.hot?.dispose')
})
it('does not start the offline engine in the ordinary web runtime', () => {
  const web = source('./web.ts')
  expect(web).not.toMatch(/ensureCacheVersion|initOfflineSync|startConnectionMonitor/)
  expect(source('./select.ts')).toContain("import('./desktop')")
  expect(source('./select.ts')).toContain("import('./web')")
})
it('limits the volatile fallback to disposable GET cache entries', () => {
  const cache = source('./cacheStore.ts')
  expect(cache).not.toMatch(/['"](?:outbox|idmap|session)['"]/)
  expect(cache).toContain("store: 'cache'")
  expect(source('../offline/outbox.ts')).toContain("from './db'")
})
it('does not represent unavailable queue storage as an empty queue', () => {
  const page = source('../views/SystemQueuePage.vue')
  expect(page).toContain('v-else-if="queueKnown"')
  expect(page).toContain('v-if="!queueKnown"')
  expect(page).toContain('busy.value || !queueKnown.value')
})
it('installs the native-module guard in Vite builds', () => {
  expect(source('../../vite.config.ts')).toContain('rendererPlatformBoundary(),')
})
