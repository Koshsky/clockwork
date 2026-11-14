import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const sources = import.meta.glob('/src/{domain,utils}/**/*.ts', {
  eager: true, query: '?raw', import: 'default',
}) as Record<string, string>
const domain = '/src/domain/'

function resolveModule(filename: string, name: string): string | null {
  const joined = name.startsWith('@/') ? '/src/' + name.slice(2) : name.startsWith('.') ? filename.slice(0, filename.lastIndexOf('/') + 1) + name : null
  if (!joined) return null
  const parts: string[] = []
  for (const part of joined.split('/')) {
    if (part === '..') parts.pop()
    else if (part && part !== '.') parts.push(part)
  }
  return '/' + parts.join('/')
}

describe('domain dependency boundaries', () => {
  const files = Object.keys(sources).filter((name) => name.startsWith(domain) && !name.endsWith('.test.ts'))
  it.each(files)('%s has no transitive framework, transport, storage or implicit clock dependency', (file) => {
    const visited = new Set<string>()
    const violations: string[] = []
    const visit = (filename: string) => {
      if (visited.has(filename)) return
      visited.add(filename)
      const source = ts.createSourceFile(filename, sources[filename]!, ts.ScriptTarget.Latest, true)
      const inspect = (node: ts.Node) => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
          const specifier = node.moduleSpecifier
          if (specifier && ts.isStringLiteral(specifier)) {
            const name = specifier.text
            const typeOnly = ts.isImportDeclaration(node) ? node.importClause?.isTypeOnly : node.isTypeOnly
            if (name === '@/api' && typeOnly) return
            const resolved = resolveModule(filename, name)
            if (!resolved || (!resolved.startsWith(domain) && !['/src/utils/date', '/src/utils/clamp'].includes(resolved))) {
              violations.push(`${filename}: ${name}`)
            } else visit(resolved + '.ts')
          }
        }
        if (ts.isIdentifier(node) && ['window', 'document', 'localStorage', 'sessionStorage', 'indexedDB', 'navigator', 'fetch', 'crypto', 'globalThis'].includes(node.text)) {
          violations.push(`${filename}: ${node.text}`)
        }
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'Date.now') violations.push(`${filename}: Date.now`)
        if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) violations.push(`${filename}: dynamic module loading`)
        if (ts.isNewExpression(node) && node.expression.getText(source) === 'Date' && !node.arguments?.length) violations.push(`${filename}: implicit current date`)
        ts.forEachChild(node, inspect)
      }
      inspect(source)
    }
    visit(file)
    expect(violations).toEqual([])
  })
})
