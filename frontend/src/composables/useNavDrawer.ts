import { computed, ref } from 'vue'

/**
 * App navigation drawer state, shared between MainLayout (which renders the
 * drawer as a layout column that shifts the content) and AppHeader (which
 * owns the burger).
 *
 *   'closed' — hidden,
 *   'pinned' — opened by the burger / Ctrl+B, stays open,
 *   'peek'   — edge-opened by holding the pointer at the left screen edge;
 *              slides back when the pointer leaves the panel.
 *
 * Module-scoped like src/theme.ts — no store needed.
 */

export type DrawerMode = 'closed' | 'peek' | 'pinned'

/** Drawer width in px; the only source of truth for the panel and the layout */
export const NAV_WIDTH = 280

/**
 * Narrow-screen breakpoint (px): below it the drawer becomes a fixed overlay
 * instead of a layout column (see the media queries in AppNavDrawer.vue).
 * Keep in sync with those CSS `max-width: 720px` media queries.
 */
export const NAV_NARROW_MAX = 720

/** True on narrow screens (overlay drawer mode); evaluated at call time. */
export function isNarrowScreen(): boolean {
  return window.matchMedia(`(max-width: ${NAV_NARROW_MAX}px)`).matches
}

const mode = ref<DrawerMode>('closed')

/** Drawer is visible in every state except 'closed' */
export const isNavOpen = computed(() => mode.value !== 'closed')

export function toggleNav(): void {
  // Burger / Ctrl+B: toggle pinned <-> closed; a peeked drawer becomes pinned.
  mode.value = mode.value === 'pinned' ? 'closed' : 'pinned'
}

export function closeNav(): void {
  mode.value = 'closed'
}

// ---------------------------------------------------------------------------
// Edge-open behaviour:
//  - closing the mouse against the left screen edge (x <= EDGE_X) peeks the
//    drawer after a short hold (avoids accidental opens when moving across
//    the edge);
//  - a peeked drawer closes again once the pointer leaves the panel area
//    (with a short grace period so it does not slam shut on tiny movements);
//  - a pinned drawer is unaffected by pointer position.
// Plus global keys: Escape closes the drawer, Ctrl/Cmd+B toggles it.
// ---------------------------------------------------------------------------
const EDGE_X = 12
const EDGE_HOLD_MS = 120
const EDGE_CLOSE_MS = 220

let edgeHoverTimer: number | undefined
let edgeLeaveTimer: number | undefined

function clearEdgeTimers(): void {
  if (edgeHoverTimer != null) {
    window.clearTimeout(edgeHoverTimer)
    edgeHoverTimer = undefined
  }
  if (edgeLeaveTimer != null) {
    window.clearTimeout(edgeLeaveTimer)
    edgeLeaveTimer = undefined
  }
}

function onMouseMove(e: MouseEvent): void {
  const x = e.clientX

  if (mode.value === 'closed') {
    if (x <= EDGE_X && edgeHoverTimer == null) {
      edgeHoverTimer = window.setTimeout(() => {
        edgeHoverTimer = undefined
        if (mode.value === 'closed') mode.value = 'peek'
      }, EDGE_HOLD_MS)
    } else if (x > EDGE_X && edgeHoverTimer != null) {
      window.clearTimeout(edgeHoverTimer)
      edgeHoverTimer = undefined
    }
  } else if (mode.value === 'peek') {
    if (x > NAV_WIDTH + EDGE_X && edgeLeaveTimer == null) {
      edgeLeaveTimer = window.setTimeout(() => {
        edgeLeaveTimer = undefined
        if (mode.value === 'peek') mode.value = 'closed'
      }, EDGE_CLOSE_MS)
    } else if (x <= NAV_WIDTH + EDGE_X && edgeLeaveTimer != null) {
      window.clearTimeout(edgeLeaveTimer)
      edgeLeaveTimer = undefined
    }
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && mode.value !== 'closed') {
    closeNav()
  }
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.code === 'KeyB') {
    e.preventDefault()
    toggleNav()
  }
}

let installed = false

/**
 * Attach the global pointer/key listeners (once). Call from the layout that
 * hosts the drawer; returns a cleanup function for unmount.
 */
export function installDrawerEdgeDetection(): () => void {
  if (installed) return () => {}
  installed = true
  window.addEventListener('mousemove', onMouseMove, { passive: true })
  window.addEventListener('keydown', onKeydown)
  return () => {
    installed = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('keydown', onKeydown)
    clearEdgeTimers()
  }
}