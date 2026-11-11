import { ref, watch } from 'vue'

/**
 * Per-user column widths persisted in localStorage (key convention:
 * `mvs_erp_table_widths.<tableId>`). Loaded once at mount, written back on
 * every change (deep watch) — widths survive reloads and revisits.
 */
const KEY_PREFIX = 'mvs_erp_table_widths.'

function read(storageKey: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + storageKey)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}

function write(storageKey: string, widths: Record<string, number>) {
  try {
    localStorage.setItem(KEY_PREFIX + storageKey, JSON.stringify(widths))
  } catch {
    // Storage full/unavailable — widths just won't persist.
  }
}

export function useColumnWidths(storageKey: string) {
  const columnWidths = ref<Record<string, number>>(read(storageKey))

  watch(
    columnWidths,
    (value) => {
      write(storageKey, value)
    },
    { deep: true },
  )

  return { columnWidths }
}