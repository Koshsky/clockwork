// @vitest-environment jsdom
/**
 * Tests for the unified assets entry point (src/assets/index.ts): the
 * custom/Default catalogs mirror each other and the custom asset wins for
 * every kind — but only when it passes the caller's validation, so an
 * invalid override of a built-in file name falls back to the default.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  customAssets,
  defaultAssets,
  isValidSvg,
  sanitizeSvg,
  mergeCatalogs,
  resolveAsset,
  resolveAssetWithCustom,
  resolveAssets,
} from './index'

// Synthetic catalogs stand in for the Vite glob inputs: the real custom
// catalog is empty by construction (src/assets/custom/hints ships no Markdown).
const defaults = new Map<string, unknown>([
  ['ru/permissions-editor.md', '# Права доступа пользователя\n\nТекст.'],
  ['ru/planner.md', '# Планировщик\n\nТекст.'],
])
const customs = new Map<string, unknown>([
  ['ru/permissions-editor.md', '# Права (кастом)\n\nПерекрытие.'],
  ['en/planner.md', '# Planner (custom)\n\nOverride.'],
])

describe('assets entry point', () => {
  it('loads the built-in hint assets by name', () => {
    const all = resolveAssets('hints')
    expect(all.size).toBeGreaterThan(0)
    expect(all.has('ru/permissions-editor.md')).toBe(true)
    const page = resolveAsset('hints', 'ru/permissions-editor.md')
    expect(typeof page).toBe('string')
    expect((page as string).startsWith('# Права доступа пользователя')).toBe(true)
  })

  it('resolves an unknown name to null', () => {
    expect(resolveAsset('hints', 'ru/nope.md')).toBeNull()
  })

  it('exposes the real catalogs as filename-keyed maps', () => {
    const byName = (m: Map<string, unknown>) => [...m.keys()]
    expect(byName(defaultAssets('hints'))).toEqual(
      expect.arrayContaining(['ru/planner.md', 'ru/permissions-editor.md']),
    )
    expect(customAssets('hints').size).toBe(0)
  })

  it('excludes documentation files (README*) from the catalogs', () => {
    expect(defaultAssets('hints').has('README.md')).toBe(false)
    expect(customAssets('hints').has('README.md')).toBe(false)
  })
})

describe('catalog merge: custom overrides default for the same file name', () => {
  const accepts = (raw: unknown): boolean =>
    typeof raw === 'string' && (raw.includes('Перекрытие') || raw.includes('Override'))

  it('a valid custom entry replaces the default of the same file name', () => {
    const merged = mergeCatalogs(defaults, customs, accepts)
    expect(merged.get('ru/permissions-editor.md')).toEqual(customs.get('ru/permissions-editor.md'))
    expect(merged.get('ru/planner.md')).toEqual(defaults.get('ru/planner.md'))
    expect(merged.get('en/planner.md')).toEqual(customs.get('en/planner.md'))
    expect(merged.size).toBe(3)
  })

  it('an invalid custom entry falls back to the default of the same file name', () => {
    const merged = mergeCatalogs(defaults, customs, () => false)
    expect(merged.get('ru/permissions-editor.md')).toEqual(defaults.get('ru/permissions-editor.md'))
    expect(merged.size).toBe(2)
  })

  it('an invalid custom file without a default counterpart is dropped entirely', () => {
    const merged = mergeCatalogs(defaults, new Map([['private.md', 'мусор']]), () => false)
    expect(merged.has('private.md')).toBe(false)
    expect(merged.size).toBe(2)
  })

  it('without a validator the custom entry wins unconditionally (backward compatible)', () => {
    const merged = mergeCatalogs(defaults, customs)
    expect(merged.get('ru/permissions-editor.md')).toEqual(customs.get('ru/permissions-editor.md'))
  })

  it('the validator is format-agnostic (works for raw Markdown strings)', () => {
    expect(accepts('# Права (кастом)\n\nПерекрытие.')).toBe(true)
    expect(accepts('# Права доступа пользователя\n\nТекст.')).toBe(false)
  })

  it('resolveAsset forwards the validator to the merge (empty real custom catalog — default stays)', () => {
    const raw = resolveAsset('hints', 'ru/permissions-editor.md', () => false)
    expect(raw).toEqual(defaultAssets('hints').get('ru/permissions-editor.md'))
  })
})

// ---------------------------------------------------------------------------
// Icons catalog (task 13/14): 14 bundled Lucide defaults, no build-time custom
// catalog (custom icons are mounted at runtime), and the async resolver that
// prefers a valid fetched custom icon over the bundled default.
// ---------------------------------------------------------------------------

/** The exact set of bundled default nav icons (file names under default/icons). */
const EXPECTED_ICONS = [
  'chart-gantt.svg',
  'chart-bar-big.svg',
  'chart-bar-stacked.svg',
  'calendar.svg',
  'user-group.svg',
  'hammer.svg',
  'users-round.svg',
  'network.svg',
  'wand-sparkles.svg',
  'tags.svg',
  'file-key.svg',
  'notebook-text.svg',
  'list.svg',
  'settings.svg',
]

/** Minimal inert inline SVG (what the runtime resolver would fetch). */
function svgPayload(marker: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3h18v18H3z"/><title>${marker}</title></svg>`
}

/** Stubs the global fetch with a canned response per URL. */
function stubFetch(impl: (url: string) => { ok: boolean; status?: number; text: () => Promise<string> }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => ({
      status: 200,
      ...impl(url),
    })),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('icons catalog', () => {
  it('bundles exactly the 14 default nav icons', () => {
    const names = [...defaultAssets('icons').keys()]
    expect(names).toHaveLength(14)
    for (const name of EXPECTED_ICONS) expect(names).toContain(name)
  })

  it('has no build-time custom catalog (custom icons are runtime-mounted)', () => {
    expect(customAssets('icons').size).toBe(0)
    expect(resolveAssets('icons').size).toBe(14)
  })

  it('resolves a bundled icon as raw inert SVG markup', () => {
    const raw = resolveAsset('icons', 'chart-gantt.svg')
    expect(typeof raw).toBe('string')
    expect((raw as string).includes('<svg')).toBe(true)
  })

  it('rejects non-SVG and active content via isValidSvg', () => {
    expect(isValidSvg('<svg></svg>')).toBe(true)
    expect(isValidSvg(svgPayload('ok'))).toBe(true)
    expect(isValidSvg('<svg><script>alert(1)</script></svg>')).toBe(false)
    expect(isValidSvg('<svg onload="x()"></svg>')).toBe(false)
    expect(isValidSvg('<svg><a href="javascript:alert(1)">x</a></svg>')).toBe(false)
    expect(isValidSvg('not svg at all')).toBe(false)
    expect(isValidSvg('<svg><svg></svg></svg>')).toBe(false)
  })
})

describe('resolveAssetWithCustom (stubbed fetch, no network)', () => {
  it('a valid custom icon wins over the bundled default', async () => {
    stubFetch(() => ({ ok: true, text: () => Promise.resolve(svgPayload('CUSTOM')) }))
    const raw = await resolveAssetWithCustom('icons', 'chart-gantt.svg')
    expect(typeof raw).toBe('string')
    expect((raw as string).includes('CUSTOM')).toBe(true)
  })

  it('an invalid custom icon falls back to the bundled default', async () => {
    stubFetch(() => ({ ok: true, text: () => Promise.resolve('<svg><script>alert(1)</script></svg>') }))
    const raw = (await resolveAssetWithCustom('icons', 'calendar.svg')) as string
    expect(raw.includes('<svg')).toBe(true)
    expect(raw.includes('<script')).toBe(false)
  })

  it('a 404 falls back to the bundled default', async () => {
    stubFetch(() => ({ ok: false, status: 404, text: () => Promise.resolve('') }))
    const raw = await resolveAssetWithCustom('icons', 'settings.svg')
    expect(raw).toEqual(defaultAssets('icons').get('settings.svg'))
  })

  it('a 404 for an unknown name resolves to null', async () => {
    stubFetch(() => ({ ok: false, status: 404, text: () => Promise.resolve('') }))
    expect(await resolveAssetWithCustom('icons', 'nope.svg')).toBeNull()
  })
})

describe('SVG XSS regressions', () => {
  it.each([
    '<svg><foreignObject><iframe srcdoc="&lt;script&gt;parent.__xss=1&lt;/script&gt;"></iframe></foreignObject></svg>',
    '<svg><a href="java&#x09;script:alert(1)"><path d="M0 0"/></a></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><set attributeName="onload" to="alert(1)"/></svg>',
    '<svg><image href="data:image/svg+xml,test"/></svg>',
    '<svg><style>body{display:none}</style></svg>',
    '<svg style="background:url(https://attacker.invalid/)"></svg>',
    '<svg><path fill="url(https://attacker.invalid/paint)"/></svg>',
    '<svg><path fill="u\\72l(https://attacker.invalid/paint)"/></svg>',
    '<svg xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></svg>',
    '<svg></svg><img src=x onerror=alert(1)>',
    '<svg><use href="#untrusted"/></svg>',
  ])('rejects active or resource-loading SVG: %s', raw => {
    expect(sanitizeSvg(raw)).toBeNull()
    expect(isValidSvg(raw)).toBe(false)
  })

  it('preserves all bundled navigation icons after sanitization', () => {
    for (const raw of defaultAssets('icons').values()) {
      const sanitized = sanitizeSvg(raw)
      expect(sanitized).not.toBeNull()
      const host = document.createElement('div')
      host.innerHTML = sanitized!
      expect(host.querySelector('svg')).not.toBeNull()
      expect(host.querySelector('script, foreignObject, iframe, style, a, image')).toBeNull()
    }
  })

  it('returns inert parsed markup for titles containing HTML-looking text', () => {
    const sanitized = sanitizeSvg('<svg><title>&lt;img src=x onerror=alert(1)&gt;</title><path d="M0 0h1"/></svg>')
    expect(sanitized).not.toBeNull()
    const host = document.createElement('div')
    host.innerHTML = sanitized!
    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('title')?.textContent).toContain('<img')
  })
})


it('a permissive custom validator cannot disable SVG sanitization', async () => {
  stubFetch(() => ({ ok: true, text: () => Promise.resolve('<svg><foreignObject><iframe srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe></foreignObject></svg>') }))
  expect(await resolveAssetWithCustom('icons', 'network.svg', { isValid: () => true })).toEqual(defaultAssets('icons').get('network.svg'))
})
