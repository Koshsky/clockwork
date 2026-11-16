/**
 * The z-index ladder gate.
 *
 * Stacking used to be a convention kept in comments: every component wrote its
 * own number, the order was documented in one place, and the numbers drifted
 * (the today line was 25 in seven comments while the code had drawn it at 35).
 * The ladder now lives in styles/tokens.css as `--z-*` tokens, and this gate
 * keeps it that way:
 *
 *   1. no raw numeric `z-index` anywhere outside the token file — a component
 *      must use a token. Two families are still numbered and are listed in
 *      PENDING_RAW_Z_INDEX: app-level overlays (dialogs, menus, toasts, the PDF
 *      preview) and a few component-local stacking needs. The list may only
 *      shrink — a stale entry fails the test.
 *   2. every `var(--z-…)` used by the sources is declared in tokens.css — a typo
 *      would otherwise resolve to `z-index: auto` and silently drop the layer to
 *      the bottom, with no build error.
 *   3. the ladder is strictly increasing, in the documented order: content →
 *      resource cells → header → today line → scale badge → side panel → corner.
 *
 * Stylesheets are read through the same `?raw` glob as the scripts, so the gate
 * needs no node APIs and could also run in the browser project; the unit project
 * enables `test.css` for that (see vitest.config.ts).
 */
import { describe, expect, it } from 'vitest'
import postcss, { type Declaration } from 'postcss'
import { parse } from '@vue/compiler-sfc'
import { NodeTypes, type RootNode, type TemplateChildNode } from '@vue/compiler-core'
import ts from 'typescript'

/** Every source file as raw text (Vite glob, like the i18n hardcoded-text gate). */
const SOURCES = import.meta.glob('/src/**/*.{ts,vue,css}', {
  eager: true,
  query: '?raw',
  import: 'default',
}) as Record<string, string>

const TOKENS_FILE = 'styles/tokens.css'

/** Generated sources: never hand-edited, so they are out of scope. */
const EXCLUDED_PREFIXES = ['api/']

/**
 * Layers that are still plain numbers, in two families:
 *  - app-level overlays (dialogs, menus, toasts, the PDF preview, the timesheet
 *    floating panels) — phase 2 turns them into `--z-popup`/`--z-toast`/… tokens;
 *  - component-local stacking (a field's popup over its siblings, a table's
 *    sticky cells) — these may end up as local rules rather than ladder tokens.
 * One entry per «file → values»; a value that is gone makes the entry stale and
 * fails the test, so the list can only shrink.
 */
const PENDING_RAW_Z_INDEX: Record<string, number[]> = {
  'components/common/AppHeader/AppHeader.vue': [100],
  'components/common/AppNavDrawer/AppNavDrawer.vue': [34990, 35000],
  'components/common/ChangelogDialog/ChangelogDialog.vue': [31000],
  'components/common/ColorField/ColorField.vue': [1, 50000],
  'components/common/ConfirmDialog/ConfirmDialog.vue': [50000],
  'components/common/ContextMenu/ContextMenu.vue': [50000],
  'components/common/DataTable/DataTable.vue': [2],
  'components/common/HintPanel/HintPanel.vue': [30000],
  'components/common/ModalForm/ModalForm.vue': [40000],
  'components/common/PasswordDialog/PasswordDialog.vue': [40000],
  'components/common/TooltipCell/TooltipCell.vue': [9999],
  'components/planner/PdfExport/PdfExport.vue': [40000],
  'components/timesheet/TimesheetGrid/TimesheetGrid.vue': [900, 1000, 1001],
  'notify/NotificationHost.vue': [1002],
  'offline/ReconnectToast.vue': [1100],
  'offline/SyncToast.vue': [1001],
  'views/PermissionsPage.vue': [10, 40001],
}

/** The documented ladder: the order is part of the contract. */
const LADDER = [
  '--z-cell-overlay',
  '--z-grid',
  '--z-bar',
  '--z-content-top',
  '--z-drop-line',
  '--z-resource-cells',
  '--z-header',
  '--z-today',
  '--z-side-backdrop',
  '--z-scale-badge',
  '--z-side-row',
  '--z-side-merged',
  '--z-side-panel',
  '--z-corner',
]

/** Scannable sources as «path relative to src/ → raw content» (tokens.css kept). */
function sourceFiles(): Map<string, string> {
  const out = new Map<string, string>()
  for (const [abs, raw] of Object.entries(SOURCES).sort(([a], [b]) => a.localeCompare(b))) {
    const rel = abs.replace(/^\/src\//, '')
    // Stories and tests emulate page chrome (sticky headers, demo layers) with
    // inline styles — the same escape the i18n gate uses for them.
    if (/\.(test|stories)\.ts$/.test(rel)) continue
    if (EXCLUDED_PREFIXES.some((prefix) => rel.startsWith(prefix))) continue
    out.set(rel, raw)
  }
  return out
}

const FILES = sourceFiles()

// Escaped literals still need parsing: their decoded value may reference a layer.
const mayContainLayer = (source: string) => /z-index|zIndex|--z-|\\/.test(source)

function declarations(file: string, source: string): Declaration[] {
  if (!mayContainLayer(source)) return []
  const result: Declaration[] = []
  const css = (text: string) => {
    if (mayContainLayer(text)) postcss.parse(text, { from: file }).walkDecls(declaration => { result.push(declaration) })
  }
  const script = (text: string) => {
    if (!mayContainLayer(text)) return
    const tree = ts.createSourceFile(file + '.ts', text, ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && ['zIndex', 'z-index'].includes(node.name.getText(tree).replace(/['"]/g, ''))) {
        const value = node.initializer
        if (ts.isNumericLiteral(value) || ts.isPrefixUnaryExpression(value) || ts.isStringLiteral(value) && /^[-+]?\d+$/.test(value.text)) {
          result.push(postcss.decl({ prop: 'z-index', value: ts.isStringLiteral(value) ? value.text : value.getText(tree) }))
        }
      }
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const value = node.text.trim()
        if (/^var\(\s*--z-[a-z-]+(?:\s*[,)]).*$/.test(value)) {
          result.push(postcss.decl({ prop: 'z-index', value }))
        } else if (/^(?:z-index\s*:|[.#:@][^{}]*\{)/.test(value)) css(value)
      }
      ts.forEachChild(node, visit)
    }
    visit(tree)
  }
  if (file.endsWith('.css')) css(source)
  else if (file.endsWith('.ts')) script(source)
  else if (file.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: file })
    descriptor.styles.forEach(style => css(style.content))
    if (descriptor.script) script(descriptor.script.content)
    if (descriptor.scriptSetup) script(descriptor.scriptSetup.content)
    function template(node: RootNode | TemplateChildNode) {
      if (node.type === NodeTypes.ELEMENT) {
        for (const property of node.props) {
          if (property.type === NodeTypes.ATTRIBUTE && property.name === 'style' && property.value) css(property.value.content)
          if (property.type === NodeTypes.DIRECTIVE && property.name === 'bind' && property.arg?.type === NodeTypes.SIMPLE_EXPRESSION && property.arg.content === 'style' && property.exp?.type === NodeTypes.SIMPLE_EXPRESSION) {
            script('const style = (' + property.exp.content + ')')
          }
        }
      }
      if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT) node.children.forEach(template)
    }
    if (descriptor.template?.ast) template(descriptor.template.ast)
  }
  return result
}

const DECLARATIONS = new Map([...FILES].map(([file, source]) => [file, declarations(file, source)]))

function declaredTokens(): Map<string, number> {
  const out = new Map<string, number>()
  for (const declaration of DECLARATIONS.get(TOKENS_FILE) ?? []) {
    if (!declaration.prop.startsWith('--z-')) continue
    expect(out.has(declaration.prop), `${declaration.prop} must be declared once`).toBe(false)
    expect(Number.isFinite(Number(declaration.value)), declaration.toString()).toBe(true)
    out.set(declaration.prop, Number(declaration.value))
  }
  return out
}

function rawNumbers(declarations: Declaration[]): Array<{ line: number; value: number }> {
  return declarations.filter(declaration => declaration.prop === 'z-index' && /^[-+]?\d+$/.test(declaration.value))
    .map(declaration => ({ line: declaration.source?.start?.line ?? 0, value: Number(declaration.value) }))
}

describe('z-index ladder', () => {
  it('no raw z-index numbers outside the token file and the pending list', () => {
    const failures: string[] = []
    const stale: string[] = []

    for (const [rel, declarations] of DECLARATIONS) {
      if (rel === TOKENS_FILE) continue
      const hits = rawNumbers(declarations)
      const allowed = PENDING_RAW_Z_INDEX[rel] ?? []
      for (const hit of hits) {
        if (!allowed.includes(hit.value)) {
          failures.push(`${rel}:${hit.line} — z-index: ${hit.value} (use a --z-* token)`)
        }
      }
      // Every pending value must still be there, otherwise the entry is dead.
      for (const value of allowed) {
        if (!hits.some((h) => h.value === value)) stale.push(`${rel} — z-index: ${value}`)
      }
    }

    expect(failures, failures.join('\n')).toEqual([])
    // A stale entry means the layer was tokenized already: drop it in the same
    // commit, so the pending list can only shrink.
    expect(stale, stale.join('\n')).toEqual([])
  })

  it('every --z-* token used in the sources is declared', () => {
    const declared = declaredTokens()
    const missing = new Set<string>()

    for (const [rel, declarations] of DECLARATIONS) {
      if (rel === TOKENS_FILE) continue
      for (const declaration of declarations) {
        for (const m of declaration.value.matchAll(/var\(\s*(--z-[a-z-]+)/g)) {
          if (!declared.has(m[1])) missing.add(`${rel} — ${m[1]}`)
        }
      }
    }

    expect([...missing].sort(), [...missing].join('\n')).toEqual([])
  })

  it('the ladder is declared once and strictly increasing', () => {
    const declared = declaredTokens()
    for (const token of LADDER) {
      expect(declared.has(token), `${token} is not declared in ${TOKENS_FILE}`).toBe(true)
    }

    const values = LADDER.map((token) => declared.get(token) as number)
    for (let i = 1; i < values.length; i++) {
      expect(
        values[i],
        `${LADDER[i]} (${values[i]}) must be above ${LADDER[i - 1]} (${values[i - 1]})`,
      ).toBeGreaterThan(values[i - 1])
    }
  })

  it('parses CSS declarations rather than comments or formatting', () => {
    expect(rawNumbers(declarations('fixture.css', `
      /* z-index: 999; */
      .overlay { z-index:
        -4 !important; }
      .token { z-index: var( --z-header ); }
    `)).map(hit => hit.value)).toEqual([-4])
    expect(rawNumbers(declarations('Fixture.vue', `
      <script setup>const explanation = 'Documentation example: z-index: 999;'</script>
      <template><div /></template>
      <style>.overlay { z-index: 7 }</style>
    `)).map(hit => hit.value)).toEqual([7])
  })

  it('finds numeric and undeclared layers in inline Vue and TypeScript styles', () => {
    const inline = declarations('Fixture.vue', `
      <template>
        <div style="z-index: 999;" :style="{ zIndex: 'var(--z-typo)' }" />
        <div :style="{ zIndex: 777 }" />
      </template>
      <script setup>const style = { zIndex: -3 }</script>
    `)
    expect(rawNumbers(inline).map(hit => hit.value)).toEqual([-3, 999, 777])
    expect(inline.filter(declaration => declaration.value.includes('--z-typo'))).toHaveLength(1)
    const typed = declarations('fixture.ts', `
      // z-index: 999;
      const explanation = 'The z-index: 999; is only an example'
      const style = { zIndex: 123, '--other': 'text', other: 'var(--z-missing)' }
      const css = '.layer { z-index: 456; }'
    `)
    expect(rawNumbers(typed).map(hit => hit.value)).toEqual([123, 456])
    expect(typed.some(declaration => declaration.value === 'var(--z-missing)')).toBe(true)
  })

})
