import { expect, it } from 'vitest'
import { forbiddenRendererImport } from '../../scripts/platform-boundaries.mjs'
it.each(['electron', 'electron/main', 'node:fs', 'fs/promises', '../desktop/preload.cjs', '/app/desktop/main.js', '../desktop/service.cjs', '../desktop/application.cjs', '../desktop/ipc.cjs'])('blocks native renderer dependency %s', id => { expect(forbiddenRendererImport(id)).toBe(true) })
it.each(['vue', '../offline/cache', './desktop', './context', '@/store'])('permits renderer module %s', id => { expect(forbiddenRendererImport(id)).toBe(false) })
