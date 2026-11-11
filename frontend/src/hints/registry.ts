/**
 * Centralized hint-content registry: every "?" explanation lives in the hint
 * ASSETS as a Markdown file (src/assets/default/hints + src/assets/custom/hints
 * — a single assets entry point with mirroring catalogs). Both catalogs are
 * locale-scoped (`<locale>/<id>.md`), so the documents follow the interface
 * language; an id missing in the active locale falls back to Russian, the
 * product language. Lookup rule (applies to every asset kind): the custom
 * asset wins when it exists, otherwise the default one is used. Invalid custom
 * assets are ignored (fall back to the default), so a broken override can
 * never break the panel.
 *
 * Mapping: the hint id is the file name without the `.md` extension (so
 * `ru/planner.md` → id `planner`); the title is the first `# ` heading of the
 * document (falling back to the id); the body is the remaining Markdown and
 * is rendered by the MarkdownView component (see
 * src/components/common/MarkdownView).
 */
import { resolveAssets } from '@/assets'
import { appLocale, type AppLocale } from '@/i18n'

export interface HintPage {
  id: string
  title: string
  /** Markdown body (everything after the title heading). */
  body: string
}

/**
 * Validates a raw value as Markdown hint content and extracts «title, body»
 * (null — invalid). The title is the first `# ` heading (empty when the
 * document has none); the body is the rest of the document.
 */
export function parseHintMarkdown(raw: unknown): { title: string; body: string } | null {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '') return null
  // First `# ` heading (line start): split the title from the body.
  const heading = /^#\s+(.+)$/m.exec(text)
  if (heading) {
    return { title: heading[1].trim(), body: text.slice(heading.index + heading[0].length).trim() }
  }
  // No heading — the whole document is the body; the caller falls back to the id.
  return { title: '', body: text }
}

/** Merges asset sets: custom pages override the defaults by id (every asset). */
export function mergeHintPages(defaults: HintPage[], custom: HintPage[]): Map<string, HintPage> {
  const out = new Map<string, HintPage>(defaults.map((p) => [p.id, p]))
  for (const p of custom) out.set(p.id, p)
  return out
}

/** Hint id from an asset name (`ru/planner.md` → `planner`). */
function hintIdFromName(assetName: string): string {
  const base = assetName.split('/').pop() ?? assetName
  return base.replace(/\.md$/i, '')
}

/** Locale folder of an asset name (`ru/planner.md` → `ru`), '' when absent. */
function localeOfName(assetName: string): string {
  const parts = assetName.split('/')
  return parts.length > 1 ? (parts[0] ?? '') : ''
}

/** Pages of one locale: «locale → (id → page)» plus the code-defined extras. */
function loadAssets(): Map<string, Map<string, HintPage>> {
  // resolveAssets('hints') keeps the custom-first rule per file name, but a
  // custom entry is merged only when it passes the validator: an invalid
  // override of a built-in file name falls back to the built-in page instead
  // of dropping the entry (the documented asset rule for every kind).
  const byLocale = new Map<string, Map<string, HintPage>>()
  for (const [name, raw] of resolveAssets('hints', (r) => parseHintMarkdown(r) !== null)) {
    const parsed = parseHintMarkdown(raw)
    if (!parsed) continue
    const locale = localeOfName(name)
    const id = hintIdFromName(name)
    const pages = byLocale.get(locale) ?? new Map<string, HintPage>()
    pages.set(id, { id, title: parsed.title === '' ? id : parsed.title, body: parsed.body })
    byLocale.set(locale, pages)
  }
  return byLocale
}

const pagesByLocale = loadAssets()

/** Pages registered from code (available in every locale, overridable per id). */
const registered: HintPage[] = []

/** Locale chain of a lookup: the active language first, then the fallback. */
function localeChain(locale: AppLocale): string[] {
  return locale === 'ru' ? ['ru'] : [locale, 'ru']
}

/** Hint page in a locale (null — the id is unknown everywhere). */
function pageIn(locale: AppLocale, id: string): HintPage | null {
  for (const loc of localeChain(locale)) {
    const page = pagesByLocale.get(loc)?.get(id)
    if (page) return page
  }
  return null
}

/**
 * Returns a hint page by id in the active language (null — unknown). Falls back
 * to the Russian document when the active locale has no translation of it.
 * Reactive: a locale switch re-resolves the panel content.
 */
export function hintPage(id: string, locale: AppLocale = appLocale.value): HintPage | null {
  return pageIn(locale, id) ?? registered.find((p) => p.id === id) ?? null
}

/** All known ids of the active language (for the stories/debug). */
export function hintPages(locale: AppLocale = appLocale.value): HintPage[] {
  const ids = new Set<string>()
  for (const loc of localeChain(locale)) {
    for (const id of pagesByLocale.get(loc)?.keys() ?? []) ids.add(id)
  }
  for (const p of registered) ids.add(p.id)
  return [...ids].map((id) => hintPage(id, locale)).filter((p): p is HintPage => p !== null)
}

/** Registers an additional code-defined page (a duplicate id is ignored). */
export function registerHint(page: HintPage): void {
  if (!page.id || registered.some((p) => p.id === page.id)) return
  registered.push(page)
}