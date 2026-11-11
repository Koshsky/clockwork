import { ref } from 'vue'
import type { Ref } from 'vue'

export interface TimelinePan {
  isPanning: Ref<boolean>
  /** Subscribe to pointerdown on the container (pan by MMB drag from any point) */
  enable: () => void
  /** Unsubscribe */
  disable: () => void
}

/**
 * Panning the infinite timeline: hold MMB (middle mouse button) anywhere —
 * empty space, bars, milestones, sticky labels, headers — and drag; the
 * container scrolls in both directions. Table content never blocks moving the
 * table: LMB interactions (bar drag, resize, reorder) are guarded by the
 * components themselves, so the MMB pan coexists with them. Horizontal scroll
 * triggers the regular scroll event, which extends the range (sync).
 * ignoreSelector (optional) — elements excluded from starting the pan.
 */
export function useTimelinePan(
  container: Ref<HTMLElement | null>,
  ignoreSelector = '',
): TimelinePan {
  const isPanning = ref(false)

  let active = false
  let lastX = 0
  let lastY = 0

  /**
   * Blocks the browser's native middle-click autoscroll: cancelling the
   * pointerdown alone is not enough in all browsers, the autoscroll is a
   * default action of the derived mousedown.
   */
  function onAutoscrollGuard(e: MouseEvent) {
    if (e.button === 1) e.preventDefault()
  }

  function onPointerDown(e: PointerEvent) {
    if (e.button !== 1 || e.ctrlKey || e.metaKey) return
    if (e.pointerType !== 'mouse') return
    const el = container.value
    if (!el) return
    if (ignoreSelector && (e.target as HTMLElement).closest(ignoreSelector)) return
    e.preventDefault()
    active = true
    lastX = e.clientX
    lastY = e.clientY
    isPanning.value = true
    el.classList.add('tg-panning')
    // Global "grabbing fist" (body.pan-grabbing) while MMB is held — applies
    // to the whole page, not only the table area.
    document.body.classList.add('pan-grabbing')
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }

  function onPointerMove(e: PointerEvent) {
    if (!active) return
    const el = container.value
    if (!el) return
    // Incremental deltas: sync() itself compensates scrollLeft when the left
    // range expands, so an absolute recompute from drag start would conflict
    // with that compensation (the pan would "stick" at the origin).
    el.scrollLeft -= e.clientX - lastX
    el.scrollTop -= e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
  }

  function onPointerUp(e?: PointerEvent) {
    if (!active) return
    const el = container.value
    // The browser coalesces fast pointermove events — the last move may not
    // reach pointerup; flush the remaining delta from the release event coords.
    if (el && e) {
      el.scrollLeft -= e.clientX - lastX
      el.scrollTop -= e.clientY - lastY
    }
    active = false
    isPanning.value = false
    container.value?.classList.remove('tg-panning')
    document.body.classList.remove('pan-grabbing')
    document.body.style.userSelect = ''
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerUp)
  }

  function enable() {
    container.value?.addEventListener('pointerdown', onPointerDown)
    container.value?.addEventListener('mousedown', onAutoscrollGuard)
  }

  function disable() {
    container.value?.removeEventListener('pointerdown', onPointerDown)
    container.value?.removeEventListener('mousedown', onAutoscrollGuard)
    onPointerUp()
  }

  return { isPanning, enable, disable }
}
