import { t } from '@/i18n'

/**
 * Preset display helpers: a preset has a tag (system access code, e.g.
 * `worker`), a human-readable name and a description. Where only the tag is
 * known (users reference presets by tag), the display name comes from the
 * catalog or falls back to the built-in label of a known tag, then to the tag
 * itself (cold start without the catalog, historic rows). The built-in labels
 * are catalog keys resolved at call time, so they follow the interface
 * language.
 */
/** Catalog keys of the seeded built-in presets (fallback only). */
const FALLBACK_PRESET_KEYS: Record<string, string> = {
  admin: 'authz.preset.admin',
  dp: 'authz.preset.dp',
  rp: 'authz.preset.rp',
  vp: 'authz.preset.vp',
  worker: 'authz.preset.worker',
}

/** Built-in label of a preset tag, or the tag itself when it is unknown. */
export function presetFallbackName(tag: string): string {
  const key = FALLBACK_PRESET_KEYS[tag]
  return key ? t(key) : tag
}

/**
 * Options of the built-in presets (cold start, before the catalog is loaded).
 * Built per call: the labels are translated at call time, so a language switch
 * is reflected on the next render.
 */
export function builtinPresetOptions(): Array<{ value: string; label: string }> {
  return Object.keys(FALLBACK_PRESET_KEYS).map((value) => ({ value, label: presetFallbackName(value) }))
}

export interface PresetLike {
  tag?: string | null
  name?: string | null
  description?: string | null
}

/** Display name of a catalog entry: the name, else the fallback, else the tag. */
export function presetDisplayName(p: PresetLike): string {
  const name = p.name?.trim()
  if (name) return name
  if (p.tag) return presetFallbackName(p.tag)
  return '—'
}

/**
 * Display name of a preset referenced by its tag: looked up in the catalog
 * (name wins), falling back to the built-in label, then to the tag itself.
 */
export function presetLabelFromCatalog(tag: string | null | undefined, catalog: PresetLike[]): string {
  if (!tag) return '—'
  const entry = catalog.find((p) => p.tag === tag)
  if (entry) return presetDisplayName(entry)
  return presetFallbackName(tag)
}

/** Description of a preset referenced by its tag (' ' when absent/empty). */
export function presetDescriptionByTag(tag: string | null | undefined, catalog: PresetLike[]): string {
  if (!tag) return ''
  return catalog.find((p) => p.tag === tag)?.description?.trim() ?? ''
}