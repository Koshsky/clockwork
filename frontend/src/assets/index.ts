/**
 * The single entry point for ALL assets (src/assets): two catalogs mirror
 * each other per kind — `default/<kind>/` holds the built-in files,
 * `custom/<kind>/` the user overrides (empty by default). Lookup rule for
 * EVERY kind (hints, fonts, …): the custom asset wins when it exists,
 * otherwise the default one is used. Invalid custom files are ignored
 * (fall back to the default), so a broken override can never break a
 * feature. Import assets only through this module.
 *
 * The asset layer itself is kind-agnostic: it merges *raw* file contents
 * and cannot interpret them. Payload validation is injected per kind by
 * the consumer via the optional `isValid` argument of
 * `resolveAssets`/`resolveAsset` (and `mergeCatalogs`): a custom entry
 * replaces the default of the same file name only when it passes
 * validation — on failure the default entry is retained, which is the
 * documented fallback. Without a validator the raw custom entry wins
 * unconditionally. The hints registry (src/hints/registry.ts) is the
 * reference consumer: it passes a `parseHintMarkdown`-based validator, so a
 * broken custom hint falls back to the built-in page.
 *
 * Hint assets are locale-scoped inside each catalog (`<kind>/<locale>/<file>`),
 * and the locale folder is part of the asset name (`ru/planner.md`), so a hint
 * document follows the interface language and an override can target one
 * language without touching the other.
 *
 * Two custom-catalog sources coexist:
 * - hints: bundled at build time via the Vite glob (Markdown pages, one
 *   locale folder deep);
 * - icons: NOT bundled — the custom icons are mounted into the container
 *   at runtime (deploy mounts ./assets/custom into
 *   /usr/share/nginx/html/assets/custom, no rebuild). They are resolved
 *   asynchronously by `resolveAssetWithCustom`, which fetches the file,
 *   validates it as an inert inline SVG and falls back to the bundled
 *   default on any fetch/validation failure.
 *
 * Documentation files named `README*` inside asset catalogs are NOT assets:
 * they are excluded by both catalog getters so a hint doc (for example
 * custom/hints/README.md) can never be picked up as a hint page.
 */

import DOMPurify from 'dompurify'

export type AssetKind = 'hints' | 'icons'

export type AssetValidator = (raw: unknown) => boolean

// Vite asset globs keyed by file path (per kind, both catalogs). The icons
// catalog is intentionally DEFAULT-ONLY: custom icons are runtime-mounted
// (task 14) and must never enter the build.

const defaultGlobs: Record<string, Record<string, unknown>> = {
  hints: import.meta.glob('./default/hints/*/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, unknown>,
  icons: import.meta.glob('./default/icons/*.svg', { eager: true, query: '?raw', import: 'default' }) as Record<string, unknown>,
}
const customGlobs: Record<string, Record<string, unknown>> = {
  hints: import.meta.glob('./custom/hints/*/*.md', { eager: true, query: '?raw', import: 'default' }) as Record<string, unknown>,
}

/** Catalog files starting with this name (case-insensitive) are docs, not assets. */
const DOC_FILE_PREFIX = 'README'

function isDocFile(name: string): boolean {
  const base = name.split('/').pop() ?? name
  return base.toUpperCase().startsWith(DOC_FILE_PREFIX)
}

/**
 * Asset name (catalog key) of a file path. Hint assets are locale-scoped
 * (`default/hints/<locale>/<id>.md`), so the locale folder is part of the name
 * (`ru/planner.md`); every other kind uses the bare file name.
 */
function assetName(filePath: string): string {
  const parts = filePath.split('/')
  const name = parts[parts.length - 1] ?? filePath
  const locale = parts[parts.length - 2]
  const kind = parts[parts.length - 3]
  // Locale-scoped kinds (hints) keep the locale folder in the key: `ru/planner.md`.
  return kind === 'hints' && locale ? `${locale}/${name}` : name
}

/** Default catalog of a kind: «file name → raw content» (README* docs excluded). */
export function defaultAssets(kind: AssetKind): Map<string, unknown> {
  return new Map(
    Object.entries(defaultGlobs[kind] ?? {})
      .map(([path, raw]) => [assetName(path), raw] as const)
      .filter(([name]) => !isDocFile(name)),
  )
}

/** Custom catalog of a kind: «file name → raw content» (empty by default; README* docs excluded). */
export function customAssets(kind: AssetKind): Map<string, unknown> {
  return new Map(
    Object.entries(customGlobs[kind] ?? {})
      .map(([path, raw]) => [assetName(path), raw] as const)
      .filter(([name]) => !isDocFile(name)),
  )
}

/**
 * Merges two catalogs: a custom entry overrides the default of the same
 * file name — but only when it passes `isValid` (or when no validator is
 * given). An invalid custom entry is skipped, so the default entry is
 * retained (the fallback); an invalid custom file without a default
 * counterpart is absent from the result.
 */
export function mergeCatalogs(
  defaults: Map<string, unknown>,
  customs: Map<string, unknown>,
  isValid?: AssetValidator,
): Map<string, unknown> {
  const out = new Map(defaults)
  for (const [name, raw] of customs) {
    if (!isValid || isValid(raw)) out.set(name, raw)
  }
  return out
}

/**
 * All assets of a kind: «file name → raw content»; custom overrides the
 * default for the same file name when it passes `isValid` (applies to
 * every asset kind).
 */
export function resolveAssets(kind: AssetKind, isValid?: AssetValidator): Map<string, unknown> {
  return mergeCatalogs(defaultAssets(kind), customAssets(kind), isValid)
}

/** A single asset of a kind by file name (null — nowhere to be found). */
export function resolveAsset(kind: AssetKind, name: string, isValid?: AssetValidator): unknown | null {
  return resolveAssets(kind, isValid).get(name) ?? null
}

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
const ICON_TAGS = ['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'title', 'desc']
const STATIC_PAINT = /^(?:[a-z]+|#[0-9a-f]{3,8}|(?:rgb|hsl)a?\([-\d.%\s,+/]*\))$/i
const ICON_ATTRIBUTES = [
  'xmlns', 'class', 'role', 'aria-label', 'width', 'height', 'viewbox',
  'fill', 'fill-rule', 'fill-opacity', 'clip-rule', 'opacity',
  'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
  'd', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'cx', 'cy', 'r', 'rx', 'ry',
  'points', 'transform', 'vector-effect', 'preserveaspectratio',
]

/** Only static geometry belongs in navigation icons; return parsed output,
 *  never the original markup that may change meaning when parsed as HTML. */
export function sanitizeSvg(raw: unknown): string | null {
  if (typeof raw !== 'string' || !DOMPurify.isSupported) return null
  const fragment = DOMPurify.sanitize(raw, {
    // DOMPurify uses a body container; only its SVG child is returned.
    ALLOWED_TAGS: [...ICON_TAGS, 'body'],
    ALLOWED_ATTR: ICON_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM_FRAGMENT: true,
  })
  // Keep the invalid-override fallback. Safety comes from the sanitized DOM,
  // including when the sanitizer did not record a removed node.
  if (DOMPurify.removed.some(entry => 'attribute' in entry || entry.element.nodeType !== 8)) return null
  const nodes = [...fragment.childNodes].filter(node => node.nodeType !== 8 && (node.nodeType !== 3 || node.textContent?.trim()))
  if (nodes.length !== 1 || !(nodes[0] instanceof Element)) return null
  const svg = nodes[0]
  if (svg.localName !== 'svg' || svg.namespaceURI !== SVG_NAMESPACE || svg.querySelector('svg')) return null
  for (const element of [svg, ...svg.querySelectorAll('*')]) {
    if (element.namespaceURI !== SVG_NAMESPACE) return null
    for (const attribute of element.attributes) {
      if (attribute.name === 'xmlns' && attribute.value !== SVG_NAMESPACE) return null
      // Static paints also reject CSS-escaped URL functions.
      if (['fill', 'stroke'].includes(attribute.name) && !STATIC_PAINT.test(attribute.value.trim())) return null
      if (/url\s*\(/i.test(attribute.value) || /[\u0000-\u001f\u007f]/.test(attribute.value)) return null
    }
  }
  return svg.outerHTML
}

/** Acceptance check for callers; rendering must use sanitizeSvg's output. */
export function isValidSvg(raw: unknown): boolean {
  return sanitizeSvg(raw) !== null
}

export interface ResolveAssetWithCustomOptions {
  /** Additional validation; SVG sanitization cannot be disabled by a caller. */
  isValid?: AssetValidator
  /** Base URL override for the custom-asset prefix (tests / non-browser environments). */
  baseURL?: string
}

/**
 * Module-level memo of resolved runtime assets, keyed by `kind:name` — the
 * final outcome (the custom override, the bundled default, or null) so a
 * repeated lookup performs no second fetch.
 */
const runtimeCustomCache = new Map<string, unknown>()

/**
 * Runtime asset resolution with a custom override. First tries the mounted
 * custom dir at `{BASE_URL}assets/custom/<kind>/<name>` (icons are overlaid
 * onto the container without a rebuild); when the fetch fails (404/network)
 * or the payload fails validation, falls back to the bundled default via
 * `resolveAsset`; null when the asset exists nowhere.
 */
export async function resolveAssetWithCustom(
  kind: AssetKind,
  name: string,
  opts?: ResolveAssetWithCustomOptions,
): Promise<unknown | null> {
  const cacheKey = `${kind}:${name}`
  if (runtimeCustomCache.has(cacheKey)) {
    return runtimeCustomCache.get(cacheKey) as unknown | null
  }
  const isValid = opts?.isValid
  const baseURL = opts?.baseURL ?? import.meta.env.BASE_URL
  let resolved: unknown | null = null
  try {
    const res = await fetch(`${baseURL}assets/custom/${kind}/${name}`)
    if (!res.ok) throw new Error(`custom asset unavailable (HTTP ${res.status})`)
    const raw = await res.text()
    if (isValid && !isValid(raw)) throw new Error('custom asset failed validation')
    resolved = kind === 'icons' ? sanitizeSvg(raw) : raw
    if (resolved === null) throw new Error('custom icon failed sanitization')
  } catch {
    // 404 / network error / invalid payload — fall back to the bundled default below.
  }
  if (resolved === null) resolved = resolveAsset(kind, name, isValid)
  runtimeCustomCache.set(cacheKey, resolved)
  return resolved
}