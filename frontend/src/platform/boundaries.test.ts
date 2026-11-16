import { expect, it, vi } from 'vitest'
import { forbiddenRendererImport, rendererPlatformBoundary } from '../../scripts/platform-boundaries.mjs'
it.each(['electron', 'electron/main', 'node:fs', 'fs/promises', '../desktop/preload.cjs', '/app/desktop/main.js', '../desktop/service.cjs', '../desktop/application.cjs', '../desktop/ipc.cjs'])('blocks native renderer dependency %s', id => { expect(forbiddenRendererImport(id)).toBe(true) })
it.each(['vue', '../offline/cache', './desktop', './context', '@/store'])('permits renderer module %s', id => { expect(forbiddenRendererImport(id)).toBe(false) })

function resolve(source: string, importer: string | undefined, error: (message: string) => never | void) {
  const hook = rendererPlatformBoundary().resolveId
  if (typeof hook !== 'function') throw new Error('Expected a renderer resolver')
  return hook.call({ error } as unknown as ThisParameterType<typeof hook>, source, importer, { isEntry: !importer, kind: 'dynamic-import' })
}

it.each(['electron', 'node:fs', '../desktop/service.cjs'])('rejects %s through the build resolver', source => {
  const error = vi.fn((message: string) => { throw new Error(message) })
  expect(() => resolve(source, '/src/dynamic-chunk.ts', error)).toThrow('Native import in renderer: ' + source)
  expect(error).toHaveBeenCalledOnce()
})
it('leaves ordinary imports and entrypoint resolution to the build pipeline', () => {
  const error = vi.fn()
  expect(resolve('vue', '/src/main.ts', error)).toBeNull()
  expect(resolve('/src/main.ts', undefined, error)).toBeNull()
  expect(error).not.toHaveBeenCalled()
})
