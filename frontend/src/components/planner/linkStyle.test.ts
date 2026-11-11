/**
 * The user-facing connector-style setting: a leaf module (no imports) shared by
 * the app settings and the Gantt connector geometry.
 */
import { describe, expect, it } from 'vitest'
import { LINK_STYLES, LINK_STYLE_DEFAULT, normalizeLinkStyle } from './linkStyle'

describe('link style setting', () => {
  it('offers six shapes and defaults to the rounded elbow', () => {
    expect(LINK_STYLES).toHaveLength(6)
    expect(LINK_STYLE_DEFAULT).toBe('rounded')
    expect(LINK_STYLES).toContain(LINK_STYLE_DEFAULT)
  })

  it('accepts every offered style', () => {
    for (const style of LINK_STYLES) {
      expect(normalizeLinkStyle(style), style).toBe(style)
    }
  })

  it('falls back to the default for anything else', () => {
    expect(normalizeLinkStyle(undefined)).toBe(LINK_STYLE_DEFAULT)
    expect(normalizeLinkStyle(null)).toBe(LINK_STYLE_DEFAULT)
    expect(normalizeLinkStyle('xxx')).toBe(LINK_STYLE_DEFAULT)
    expect(normalizeLinkStyle(42)).toBe(LINK_STYLE_DEFAULT)
    expect(normalizeLinkStyle({})).toBe(LINK_STYLE_DEFAULT)
  })
})
