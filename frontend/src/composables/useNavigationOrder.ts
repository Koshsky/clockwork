import { reactive, watch } from 'vue'
import type { NavCategory, NavItem } from './useNavigation'

/**
 * Client-side, per-device navigation order (categories = sections, items =
 * subsections). The user can drag a section among sections, and a subsection
 * only within its own section. Like the collapse/expand nav state, the
 * arrangement is kept in localStorage and survives reloads.
 *
 * Ordering is remembered by STABLE keys — category label, item name — not by
 * indices, so it remains correct when RBAC hides or later reveals items (a
 * hidden item falls back to its default relative place and appears in the
 * right position once its permission arrives).
 */

const ORDER_KEY = 'mvs_erp_nav_order'

interface NavOrder {
  /** Ordered category labels (fallback: the default NAV_CATEGORIES order) */
  categoryOrder: string[]
  /** Category label → ordered item names (subsections within that section) */
  itemOrder: Record<string, string[]>
}

function readNavOrder(): NavOrder {
  try {
    const raw = localStorage.getItem(ORDER_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<NavOrder>
      return {
        categoryOrder: Array.isArray(parsed.categoryOrder) ? parsed.categoryOrder : [],
        itemOrder:
          parsed.itemOrder && typeof parsed.itemOrder === 'object' && !Array.isArray(parsed.itemOrder)
            ? parsed.itemOrder
            : {},
      }
    }
  } catch {
    // storage unavailable or corrupted — start from the default order
  }
  return { categoryOrder: [], itemOrder: {} }
}

/** Live navigation-order state (mutated only through the helpers below). */
export const navOrder = reactive<NavOrder>(readNavOrder())

watch(() => JSON.stringify(navOrder), persist, { deep: true })

function persist(): void {
  try {
    localStorage.setItem(ORDER_KEY, JSON.stringify(navOrder))
  } catch {
    // persistence is not critical
  }
}

function moveInList<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice()
  if (from < 0 || from >= out.length) return out
  const [moved] = out.splice(from, 1)
  const at = Math.max(0, Math.min(to, out.length))
  out.splice(at, 0, moved)
  return out
}

/** Union that keeps preserved-only keys and drops nothing currently absent. */
function mergeByPresence(front: string[], tail: string[]): string[] {
  const out = front.slice()
  for (const key of tail) if (!out.includes(key)) out.push(key)
  return out
}

/**
 * Applies a user-stored ordering onto `reference` (the full default order),
 * producing a stable total order of currently available `key`s. Keys pinned by
 * the user lead in their chosen sequence; unpinned keys follow in reference order.
 */
function applyOrderedKeys(
  available: string[],
  stored: string[],
  reference: string[],
): string[] {
  const out: string[] = []
  const push = (k: string) => {
    if (available.includes(k) && !out.includes(k)) out.push(k)
  }
  for (const k of stored) push(k)
  for (const k of reference) push(k)
  for (const k of available) push(k)
  return out
}

/**
 * Applies the saved arrangement to an RBAC-filtered category list.
 * Returns a copy ordered as the user saved it.
 */
export function applyCategoryOrder(categories: NavCategory[]): NavCategory[] {
  if (categories.length < 2) return categories
  const labels = categories.map((c) => c.label)
  const ordered = applyOrderedKeys(labels, navOrder.categoryOrder, labels)
  const map = new Map(categories.map((c) => [c.label, c]))
  return ordered.map((label) => map.get(label)!).filter(Boolean)
}

/**
 * Applies the saved arrangement to the items of one category.
 * Returns a copy ordered as the user saved it.
 */
export function applyItemOrder(catLabel: string, items: NavItem[]): NavItem[] {
  if (items.length < 2) return items
  const names = items.map((i) => i.name)
  const stored = navOrder.itemOrder[catLabel] ?? []
  const ordered = applyOrderedKeys(names, stored, names)
  const map = new Map(items.map((i) => [i.name, i]))
  return ordered.map((name) => map.get(name)!).filter(Boolean)
}

/**
 * Reorders categories. `orderedVisible` is the fully-resolved order currently
 * shown to the user (from applyCategoryOrder); `from`/`to` are indices within it.
 */
export function saveCategoryOrder(orderedVisible: readonly string[], from: number, to: number): void {
  const next = moveInList(orderedVisible, from, to)
  navOrder.categoryOrder = mergeByPresence(next, navOrder.categoryOrder)
}

/**
 * Reorders items of one category. `orderedVisibleItemNames` is the resolved
 * order currently shown (from applyItemOrder); `from`/`to` are indices into it.
 * Items can only move within — never across categories.
 */
export function saveItemOrder(
  catLabel: string,
  orderedVisibleItemNames: readonly string[],
  from: number,
  to: number,
): void {
  const next = moveInList(orderedVisibleItemNames, from, to)
  const saved = navOrder.itemOrder[catLabel] ?? []
  navOrder.itemOrder[catLabel] = mergeByPresence(next, saved)
  navOrder.itemOrder = { ...navOrder.itemOrder }
}
