import { onBeforeUnmount } from 'vue'

export interface WindowPointerTrackOptions {
  onMove?: (e: PointerEvent) => void
  onUp?: (e: PointerEvent) => void
  onCancel?: () => void
}

/**
 * Tracks the pointer on window during a drag: pointermove/pointerup/
 * pointercancel subscriptions and selection blocking (userSelect). start()
 * enables it, stop() disables it. On unmount mid-drag the listeners are
 * removed automatically (otherwise they and userSelect="none" were left forever).
 */
export function useWindowPointerTrack(opts: WindowPointerTrackOptions) {
  function onMove(e: PointerEvent) {
    opts.onMove?.(e)
  }
  function onUp(e: PointerEvent) {
    opts.onUp?.(e)
  }
  function onCancel() {
    opts.onCancel?.()
  }

  function start() {
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    document.body.style.userSelect = 'none'
  }

  function stop() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    document.body.style.userSelect = ''
  }

  onBeforeUnmount(stop)

  return { start, stop }
}
