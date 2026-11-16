/**
 * Tests for the global hint-panel state (src/composables/useHints.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeHints, hintOpen, hintPageContent, hintPageRef, openHintPage } from './useHints'

const resetPanel = () => { closeHints(); hintPageRef.value = null }
beforeEach(resetPanel)
afterEach(resetPanel)

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
    expect(hintPageContent.value).toBeNull()
  })

  it('keeps the current panel when an unknown page is requested', () => {
    openHintPage('scope-expressions')
    openHintPage('no-such-page')
    expect(hintOpen.value).toBe(true)
    expect(hintPageContent.value?.id).toBe('scope-expressions')
  })
})
