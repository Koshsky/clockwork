import { ref } from 'vue'
import type { Ref } from 'vue'

export interface ConfirmState {
  message: string
  confirmLabel?: string
  /** Called on confirmation (after the dialog closes) */
  onConfirm: () => void
}

/**
 * Built-in confirmation dialog instead of window.confirm.
 * window.confirm is blocked in iframe/sandbox and returns false — as a result
 * delete handlers aborted before sending DELETE. ask() opens the dialog,
 * proceed() confirms, cancel() cancels.
 */
export function useConfirm() {
  const confirm: Ref<ConfirmState | null> = ref(null)

  function ask(message: string, onConfirm: () => void, confirmLabel?: string) {
    confirm.value = { message, onConfirm, confirmLabel }
  }

  function proceed() {
    const c = confirm.value
    if (!c) return
    confirm.value = null
    c.onConfirm()
  }

  function cancel() {
    confirm.value = null
  }

  return { confirm, ask, proceed, cancel }
}
