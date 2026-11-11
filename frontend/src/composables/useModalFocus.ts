import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Ref } from 'vue'

/**
 * Accessible modal focus management (WAI-ARIA dialog pattern).
 *
 * Covers the four behaviours a modal needs, all driven by a single `open` flag:
 *
 *  1. initial focus — moves the focus into the dialog on open: the first
 *     focusable element inside it, otherwise the dialog itself;
 *  2. focus trap — Tab / Shift+Tab cycle inside the dialog and never reach the
 *     content behind it (the trap listens on the dialog, so it also keeps
 *     working when the focus sits on the dialog container);
 *  3. focus restore — the element that had focus before opening (the trigger)
 *     gets it back on close and on unmount;
 *  4. Escape from anywhere — the document-level keydown handler fires even when
 *     the focus is outside the dialog (Teleport moves the markup to <body>, so
 *     an overlay `@keydown` alone would never see it).
 *
 * Usage:
 *
 *  const { dialogEl, onKeydown } = useModalFocus({
 *    open: () => props.open,
 *    onClose: () => emit('close'),
 *  })
 *
 *  <div ref="dialogEl" role="dialog" aria-modal="true" tabindex="-1" @keydown="onKeydown">
 *
 * The dialog (or an editable ancestor of the fields) should carry
 * `tabindex="-1"` so that it can take the focus when it has no focusable
 * children. The composable never renders anything and never touches styles.
 */

/** Selector of the elements that can receive the focus inside a dialog */
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Elements that are not visible (or explicitly hidden) must not take focus */
function isShown(el: HTMLElement): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return false
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false
  // offsetParent is null for display:none subtrees; the dialog itself may be
  // position:fixed (offsetParent === null) so it is checked separately.
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false
  return true
}

/** Focusable children of `root`, in DOM order, skipping disabled/hidden ones */
export function getFocusable(root: HTMLElement | null): HTMLElement[] {
  if (!root) return []
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1 && isShown(el),
  )
}

export interface UseModalFocusOptions {
  /** Reactive open flag of the modal (getter or ref) */
  open: () => boolean
  /** Called when Escape is pressed while the modal is open */
  onClose?: () => void
  /**
   * Also close on Escape when the focus sits on a form control inside the
   * dialog (default true). Matches the native <dialog> behaviour.
   */
  closeOnEscape?: boolean
  /**
   * Focus the first focusable element instead of the dialog container when the
   * modal opens (default true — a container focus would hide the fact that the
   * fields are reachable).
   */
  focusFirst?: boolean
}

export interface UseModalFocusReturn {
  /** Bind to the dialog element via `ref="dialogEl"` */
  dialogEl: Ref<HTMLElement | null>
  /** Bind to the dialog element via `@keydown="onKeydown"` (focus trap) */
  onKeydown: (event: KeyboardEvent) => void
}

export function useModalFocus(options: UseModalFocusOptions): UseModalFocusReturn {
  // A REAL Vue ref (not a plain { value: null } object): the production runtime
  // normalizes template refs through setRef and crashes on a raw plain object
  // (dev tolerated it, prod threw "reading 'refs' of undefined"). The template
  // in the calling component binds ref="dialogEl" to this ref.
  const dialogEl = ref<HTMLElement | null>(null)
  return useModalFocusImpl(options, dialogEl)
}

/**
 * Internal factory that lets the caller keep its own typed template ref while
 * the composable drives the focus. Kept private: the public API is a plain
 * `useModalFocus()` whose `dialogEl` is bound in the template.
 */
function useModalFocusImpl(
  options: UseModalFocusOptions,
  dialogEl: Ref<HTMLElement | null>,
): UseModalFocusReturn {
  const { open, onClose, closeOnEscape = true, focusFirst = true } = options

  /** Element that had the focus before the modal opened (the trigger) */
  let restoreTo: HTMLElement | null = null
  let wasOpen = false

  function isOpen(): boolean {
    return !!open()
  }

  function focusInitial(): void {
    const dialog = dialogEl.value
    if (!dialog) return
    const target = focusFirst ? (getFocusable(dialog)[0] ?? dialog) : dialog
    target.focus({ preventScroll: true })
  }

  /** Tab / Shift+Tab cycle inside the dialog */
  function trapTab(event: KeyboardEvent): void {
    const dialog = dialogEl.value
    if (!dialog) return
    const items = getFocusable(dialog)
    if (items.length === 0) {
      // Nothing focusable inside: keep the focus on the dialog itself.
      event.preventDefault()
      dialog.focus({ preventScroll: true })
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = !!active && dialog.contains(active)

    if (event.shiftKey) {
      if (!inside || active === first || active === dialog) {
        event.preventDefault()
        last.focus({ preventScroll: true })
      }
      return
    }
    if (!inside || active === last) {
      event.preventDefault()
      first.focus({ preventScroll: true })
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (!isOpen()) return
    if (event.key === 'Escape') {
      if (!closeOnEscape) return
      event.preventDefault()
      event.stopPropagation()
      onClose?.()
      return
    }
    if (event.key === 'Tab') trapTab(event)
  }

  /** Escape must work even when the focus is outside the dialog */
  function onDocumentKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || !isOpen()) return
    // A confirmation or a teleported picker owns Escape while focused.
    const focusedDialog = (event.target as Element | null)?.closest?.('[role=dialog]')
    if (focusedDialog && focusedDialog !== dialogEl.value) return
    // The dialog's own handler already dealt with it; ignore the bubbled copy.
    if (dialogEl.value && dialogEl.value.contains(event.target as Node)) return
    if (!closeOnEscape) return
    event.preventDefault()
    onClose?.()
  }

  function handleOpen(): void {
    restoreTo = (document.activeElement as HTMLElement | null) ?? null
    // The Teleported markup may not be in the DOM yet on the first tick.
    void nextTick(() => {
      if (isOpen()) focusInitial()
    })
    document.addEventListener('keydown', onDocumentKeydown, true)
  }

  function handleClose(): void {
    document.removeEventListener('keydown', onDocumentKeydown, true)
    const target = restoreTo
    restoreTo = null
    if (!target || !target.isConnected) return
    // Let the closing modal unmount before returning the focus, otherwise the
    // dialog would steal it back (or the browser would reset it to <body>).
    void nextTick(() => {
      if (isOpen()) return
      if (typeof target.focus === 'function') target.focus({ preventScroll: true })
    })
  }

  watch(
    () => isOpen(),
    (value) => {
      if (value === wasOpen) return
      wasOpen = value
      if (value) handleOpen()
      else handleClose()
    },
    { immediate: true, flush: 'post' },
  )

  onBeforeUnmount(() => {
    document.removeEventListener('keydown', onDocumentKeydown, true)
    // Unmount while open (route change, parent v-if) must not lose the focus.
    if (wasOpen) {
      const target = restoreTo
      restoreTo = null
      if (target?.isConnected && typeof target.focus === 'function') target.focus()
    }
  })

  return { dialogEl, onKeydown }
}
