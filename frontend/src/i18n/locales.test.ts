/**
 * Catalog completeness gate: every key of the Russian catalog (the source of
 * truth) must exist in the English catalog and vice versa, and no translation
 * may be an empty string. Missing keys would silently fall back to Russian
 * (fallbackLocale), so "it works" is not proof of a complete translation —
 * this test is.
 */
import { describe, expect, it } from 'vitest'
import en from './locales/en'
import ru from './locales/ru'

interface Tree {
  [key: string]: string | Tree
}

/** Flattens a catalog into dotted key paths. */
function flatten(node: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out.set(path, value)
    } else {
      for (const [k, v] of flatten(value, path)) out.set(k, v)
    }
  }
  return out
}

const ruKeys = flatten(ru as unknown as Tree)
const enKeys = flatten(en as unknown as Tree)

describe('message catalogs', () => {
  it('has no Russian key missing from the English catalog', () => {
    const missing = [...ruKeys.keys()].filter((k) => !enKeys.has(k)).sort()
    expect(missing).toEqual([])
  })

  it('has no English key absent from the Russian catalog', () => {
    const extra = [...enKeys.keys()].filter((k) => !ruKeys.has(k)).sort()
    expect(extra).toEqual([])
  })

  it('has no empty translations', () => {
    const emptyRu = [...ruKeys.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k)
    const emptyEn = [...enKeys.entries()].filter(([, v]) => v.trim() === '').map(([k]) => k)
    expect([...emptyRu, ...emptyEn]).toEqual([])
  })

  it('keeps interpolation placeholders aligned between the catalogs', () => {
    const placeholders = (s: string): string[] => (s.match(/\{[a-zA-Z0-9_]+\}/g) ?? []).sort()
    const mismatched = [...ruKeys.entries()]
      .filter(([k, v]) => JSON.stringify(placeholders(v)) !== JSON.stringify(placeholders(enKeys.get(k) ?? '')))
      .map(([k]) => k)
    expect(mismatched).toEqual([])
  })
})
