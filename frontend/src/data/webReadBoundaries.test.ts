import { expect, it } from 'vitest'
const views = import.meta.glob(['../views/*.vue', '../composables/*.ts', '!../composables/*.test.ts'], { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
it('delegates transport from every view and composable to read adapters', () => {
  for (const [file, source] of Object.entries(views)) {
    expect(source, file).not.toMatch(/\bnew\s+\w+Api\(/)
    expect(source, file).not.toMatch(/\bfetch\(/)
  }
})
