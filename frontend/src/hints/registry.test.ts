/**
 * Tests for the centralized hint registry (src/hints/registry.ts) — asset
 * loading with the user-overrides-defaults rule. Hints are Markdown files in
 * locale folders (`<locale>/<id>.md`): the id comes from the file name, the
 * title from the first `# ` heading, and the body is the remaining Markdown.
 * A locale without a translation of an id falls back to the Russian document.
 */
import { describe, expect, it } from 'vitest'
import {
  hintPage,
  hintPages,
  mergeHintPages,
  parseHintMarkdown,
  registerHint,
  type HintPage,
} from './registry'

describe('hint registry', () => {
  it('loads valid built-in asset pages', () => {
    const pages = hintPages()
    expect(pages.length).toBeGreaterThan(0)
    for (const p of pages) {
      expect(p.id).toBeTruthy()
      expect(p.title).toBeTruthy()
      expect(typeof p.body).toBe('string')
      expect(p.body.length).toBeGreaterThan(0)
    }
  })

  it('maps file names to ids and headings to titles', () => {
    expect(hintPage('scope-expressions', 'ru')?.title).toBe('Условия доступа')
    expect(hintPage('planner', 'ru')?.title).toBe('Планировщик')
    expect(hintPage('nope')).toBeNull()
  })

  it('resolves every built-in hint in English as a genuine translation', () => {
    const russian = hintPages('ru')
    expect(russian.length).toBeGreaterThan(0)
    // The Russian lookup itself still works.
    for (const page of russian) {
      expect(hintPage(page.id, 'ru')).not.toBeNull()
    }
    // Every Russian id MUST have an English file: a missing one resolves
    // through the Russian fallback instead of returning null, so resolve
    // alone is not enough — the English title must differ from the Russian
    // one (all built-in ids have distinct RU/EN titles).
    for (const page of russian) {
      const en = hintPage(page.id, 'en')
      expect(en, `missing English translation of hint '${page.id}'`).not.toBeNull()
      expect(en!.title, `hint '${page.id}' in English is the Russian fallback`).not.toBe(page.title)
    }
    // The English catalog covers exactly the built-in ids, no more.
    expect(hintPages('en').length).toBe(russian.length)
  })

  it('ignores duplicate registrations', () => {
    const before = hintPages().length
    const dup: HintPage = { id: 'scope-expressions', title: 'dup', body: 'дубль' }
    registerHint(dup)
    expect(hintPages().length).toBe(before)
  })
})

describe('hint asset rules (apply to every asset)', () => {
  const def: HintPage = { id: 'a', title: 'default a', body: 'дефолтный текст' }
  const custom: HintPage = { id: 'a', title: 'custom a', body: 'пользовательский текст' }
  const other: HintPage = { id: 'b', title: 'b', body: 'ещё текст' }

  it('the user asset wins over the default by id', () => {
    const merged = mergeHintPages([def, other], [custom])
    expect(merged.get('a')?.title).toBe('custom a')
    expect(merged.get('b')?.title).toBe('b')
    expect(merged.size).toBe(2)
  })
})

describe('parseHintMarkdown', () => {
  it('splits the first # heading into the title and the rest into the body', () => {
    const parsed = parseHintMarkdown('# Планировщик\n\nТекст абзаца.\n\n- пункт')
    expect(parsed).toEqual({ title: 'Планировщик', body: 'Текст абзаца.\n\n- пункт' })
  })

  it('title falls back to empty (caller uses the id) when there is no heading', () => {
    const parsed = parseHintMarkdown('Просто текст без заголовка.')
    expect(parsed?.title).toBe('')
    expect(parsed?.body).toBe('Просто текст без заголовка.')
  })

  it('rejects non-strings and empty strings', () => {
    expect(parseHintMarkdown(null)).toBeNull()
    expect(parseHintMarkdown(undefined)).toBeNull()
    expect(parseHintMarkdown(42)).toBeNull()
    expect(parseHintMarkdown({})).toBeNull()
    expect(parseHintMarkdown('')).toBeNull()
    expect(parseHintMarkdown('   \n ')).toBeNull()
  })
})