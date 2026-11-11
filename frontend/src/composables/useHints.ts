/**
 * Global hint-panel state: a single right-side explanation panel opened by any
 * "?" button of the app. The active panel shows the hint page (from the
 * centralized registry — src/hints/registry.ts) bound to the clicked button.
 * Module-level singleton (pattern of useNavDrawer): one panel for the whole
 * app, pages switch the content in place.
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { hintPage, type HintPage } from '@/hints/registry'

const open = ref(false)
const pageId = ref<string | null>(null)

/** The currently shown hint page (null — panel closed/unknown id). */
export const hintPageRef: Ref<string | null> = pageId
export const hintOpen: Ref<boolean> = open

export const hintPageContent: ComputedRef<HintPage | null> = computed(() =>
  pageId.value ? hintPage(pageId.value) : null,
)

/** Opens the right-side hint panel with the given hint page. */
export function openHintPage(id: string): void {
  if (!hintPage(id)) {
    if (import.meta.env.DEV) console.warn(`[hints] unknown hint page "${id}"`)
    return
  }
  pageId.value = id
  open.value = true
}

/** Closes the hint panel (keeps the last page for the next open). */
export function closeHints(): void {
  open.value = false
}