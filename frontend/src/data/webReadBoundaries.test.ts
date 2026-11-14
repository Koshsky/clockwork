import { expect, it } from 'vitest'
import ts from 'typescript'
import { parse } from '@vue/compiler-sfc'

const files = import.meta.glob(['../**/*.ts', '../**/*.vue', '!../api/**', '!../**/*.test.ts', '!../**/*.stories.ts', '!../store/data/adapters/**'], { eager: true, query: '?raw', import: 'default' }) as Record<string, string>
function violations(filename: string, code: string): string[] {
  const scripts = filename.endsWith('.vue') ? (() => {
    const { descriptor } = parse(code)
    return [descriptor.script?.content, descriptor.scriptSetup?.content].filter((s): s is string => Boolean(s))
  })() : [code]
  const found: string[] = []
  for (const script of scripts) {
    const source = ts.createSourceFile(filename, script, ts.ScriptTarget.Latest, true)
    const apiNames = new Set<string>()
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue
      const clause = node.importClause, bindings = clause?.namedBindings
      if (clause?.isTypeOnly) continue
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        if (!item.isTypeOnly && (item.propertyName ?? item.name).text.endsWith('Api')) apiNames.add(item.name.text)
      }
      if (/^\.\.\/(views|layouts)\//.test(filename) && node.moduleSpecifier.text.startsWith('@/offline/')) found.push('UI offline import')
      if (filename === '../main.ts' && node.moduleSpecifier.text.includes('offline/')) found.push('bootstrap offline import')
    }
    const inspect = (node: ts.Node) => {
      if (ts.isNewExpression(node)) {
        const name = ts.isIdentifier(node.expression) ? node.expression.text : ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ''
        if (name.endsWith('Api') || apiNames.has(name)) found.push('generated client')
      }
      if (/^\.\.\/(views|composables)\//.test(filename) && ts.isCallExpression(node)) {
        const call = node.expression
        if (ts.isIdentifier(call) && call.text === 'fetch' || ts.isPropertyAccessExpression(call) && call.name.text === 'fetch') found.push('UI fetch')
      }
      if (/^\.\.\/(views|layouts)\//.test(filename) && ts.isPropertyAccessExpression(node) && ['session', 'queue', 'service'].includes(node.name.text)) {
        const object = node.expression
        if (ts.isIdentifier(object) && object.text === 'erpDesktop' || ts.isPropertyAccessExpression(object) && object.name.text === 'erpDesktop') found.push('UI native IPC')
      }
      ts.forEachChild(node, inspect)
    }
    inspect(source)
  }
  return found
}
it('keeps generated clients in adapters, direct transport out of UI and offline services out of bootstrap', () => {
  for (const [filename, source] of Object.entries(files)) expect(violations(filename, source), filename).toEqual([])
})
it.each([
  ['../store/index.ts', "import { TasksApi as Client } from '@/api'; new Client ()", 'generated client'],
  ['../views/Task.vue', '<script setup>new api.TasksApi ()</script>', 'generated client'],
  ['../composables/useTask.ts', 'fetch ("/task")', 'UI fetch'],
  ['../views/Task.vue', '<script>window.fetch ("/task")</script>', 'UI fetch'],
  ['../views/Task.vue', '<script setup>window.erpDesktop?.queue.request({})</script>', 'UI native IPC'],
  ['../layouts/Main.vue', "<script setup>import { pendingCount } from '@/offline/outbox'</script>", 'UI offline import'],
  ['../main.ts', "import { initOfflineSync } from './offline/sync'", 'bootstrap offline import'],
])('rejects executable boundary violations in %s', (filename, source, violation) => {
  expect(violations(filename, source)).toContain(violation)
})
it('ignores comments, text and type-only imports rather than matching source substrings', () => {
  expect(violations('../views/Task.vue', `<script setup lang="ts">
    import type { TasksApi } from '@/api'
    // new TasksApi(); fetch('/task'); window.erpDesktop.queue.request({})
    const help = "fetch('/task')"
  </script><template><p>new TasksApi()</p></template>`)).toEqual([])
})
