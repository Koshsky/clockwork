/**
 * Tests for the global hint-panel state (src/composables/useHints.ts).
 */
import { describe, expect, it } from 'vitest'
import { closeHints, hintOpen, hintPageContent, openHintPage } from './useHints'

describe('useHints', () => {
  it('opens a known page and exposes its content', () => {
    openHintPage('scope-expressions')
    expect(hintOpen.value).toBe(true)
    expect(hintPageContent.value?.id).toBe('scope-expressions')
  })

  it('closes the panel', () => {
    openHintPage('scope-expressions')
    closeHints()
    expect(hintOpen.value).toBe(false)
    // The last page is kept for the next open.
    expect(hintPageContent.value?.id).toBe('scope-expressions')
  })

  it('ignores unknown pages', () => {
    openHintPage('no-such-page')
    expect(hintOpen.value).toBe(false)
  })
})