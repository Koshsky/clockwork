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

/** The token block of styles/tokens.css as «token → value». */
function declaredTokens(): Map<string, number> {
  const css = FILES.get(TOKENS_FILE)
  expect(css, `${TOKENS_FILE} must be readable (see test.css in vitest.config.ts)`).toBeTruthy()
  const out = new Map<string, number>()
  for (const m of (css ?? '').matchAll(/(--z-[a-z-]+):\s*(\d+);/g)) out.set(m[1], Number(m[2]))
  return out
}

/** Raw `z-index: <number>` declarations of one file, with line numbers. */
function rawNumbers(raw: string): Array<{ line: number; value: number }> {
  const hits: Array<{ line: number; value: number }> = []
  raw.split('\n').forEach((text, i) => {
    const m = text.match(/z-index:\s*(\d+)\s*;/)
    if (m) hits.push({ line: i + 1, value: Number(m[1]) })
  })
  return hits
}

describe('z-index ladder', () => {
  it('no raw z-index numbers outside the token file and the pending list', () => {
    const failures: string[] = []
    const stale: string[] = []

    for (const [rel, raw] of FILES) {
      if (rel === TOKENS_FILE) continue
      const hits = rawNumbers(raw)
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

    for (const [rel, raw] of FILES) {
      if (rel === TOKENS_FILE) continue
      for (const m of raw.matchAll(/var\((--z-[a-z-]+)/g)) {
        if (!declared.has(m[1])) missing.add(`${rel} — ${m[1]}`)
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

  it('the diagram ladder itself is complete (only floating overlays lag behind)', () => {
    // Everything the diagram and its chrome need is tokenized; the only
    // planner/timesheet files still allowed a number are the floating overlays
    // (the PDF preview and the timesheet's range tip/panel/overlay).
    const pendingHere = Object.keys(PENDING_RAW_Z_INDEX).filter(
      (rel) => rel.startsWith('components/planner/') || rel.startsWith('components/timesheet/'),
    )
    expect(pendingHere).toEqual([
      'components/planner/PdfExport/PdfExport.vue',
      'components/timesheet/TimesheetGrid/TimesheetGrid.vue',
    ])
  })
})
