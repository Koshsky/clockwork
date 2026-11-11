<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { NavCategory, NavItem } from '../../../composables/useNavigation'
import { NAV_WIDTH } from '../../../composables/useNavDrawer'
import { AppIcon, type AppIconName } from '../AppIcon'
import { useWindowPointerTrack } from '../../../utils/windowPointer'
import { resolveAssetWithCustom } from '../../../assets'
import { t } from '../../../i18n'
import type { AppNavDrawerEmits, AppNavDrawerProps } from './types'

const props = withDefaults(defineProps<AppNavDrawerProps>(), { brand: 'MVS ERP' })
const emit = defineEmits<AppNavDrawerEmits>()
const router = useRouter()

/** Navigate to a subsection on a genuine click (not after a drag). */
function onItemNavigate(e: Event, item: NavItem) {
  if (isSuppressedClick()) return
  e.preventDefault()
  emit('close')
  void router.push(item.to)
}

/** Toggle the group on a genuine click (not after dragging the header). */
function onHeadClick(cat: NavCategory) {
  if (isSuppressedClick()) return
  toggleGroup(cat)
}

// ---------------------------------------------------------------------------
// Collapsed groups — persisted per group label so the layout survives reloads.
// Any group can be collapsed, including the one holding the active route.
// When navigation moves into another group it is auto-expanded (the current
// context should be visible), but a manually collapsed active group stays
// collapsed until the user expands it or moves to another section.
// ---------------------------------------------------------------------------
const COLLAPSED_KEY = 'mvs_erp_nav_collapsed'

function readCollapsed(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    // storage unavailable or corrupted — start collapsed-free
  }
  return new Set()
}

const collapsed = ref<Set<string>>(readCollapsed())

function persistCollapsed(): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed.value]))
  } catch {
    // persistence is not critical
  }
}

const activeCategory = computed<NavCategory | undefined>(() =>
  props.categories.find((c) => c.items.some((i) => i.name === props.activeName)),
)

/** A group is open purely by the user's choice (persisted per label) */
function isOpen(cat: NavCategory): boolean {
  return !collapsed.value.has(cat.label)
}

function toggleGroup(cat: NavCategory): void {
  if (collapsed.value.has(cat.label)) collapsed.value.delete(cat.label)
  else collapsed.value.add(cat.label)
  persistCollapsed()
}

// Auto-expand the group the user navigated into (route change), so the active
// context is never hidden behind a collapsed header.
watch(activeCategory, (cat) => {
  if (cat && collapsed.value.has(cat.label)) {
    collapsed.value.delete(cat.label)
    persistCollapsed()
  }
})

/* ---------------------------------------------------------------------------
 * Group expand/collapse transitions.
 * The visible height of the clip container animates between 0 and the real
 * scrollHeight while the content fades. The clip has `overflow: hidden`, so
 * the items themselves never move or squash — the block closes like a
 * curtain and sibling section headers slide smoothly.
 * ---------------------------------------------------------------------------
 */
function onBeforeEnter(el: Element): void {
  const e = el as HTMLElement
  e.style.height = '0px'
  e.style.opacity = '0'
}

function onEnter(el: Element): void {
  const e = el as HTMLElement
  // Next frame: browser has painted the 0 state, now animate to full height
  requestAnimationFrame(() => {
    e.style.height = `${e.scrollHeight}px`
    e.style.opacity = '1'
  })
}

function onBeforeLeave(el: Element): void {
  const e = el as HTMLElement
  e.style.height = `${e.scrollHeight}px`
}

function onLeave(el: Element): void {
  const e = el as HTMLElement
  requestAnimationFrame(() => {
    e.style.height = '0px'
    e.style.opacity = '0'
  })
}

/** Drop inline height/opacity once the transition finishes (back to auto) */
function onAfterClear(el: Element): void {
  const e = el as HTMLElement
  e.style.height = ''
  e.style.opacity = ''
}

// ---------------------------------------------------------------------------
// Drag-and-drop reordering.
// Sections (categories) can be dragged anywhere among sections; subsection rows
// can only be dragged WITHIN their own section (never across). A drag starts on
// ANY point of the row: we track from pointerdown and only commit a drag once
// the pointer has moved past a threshold — so a plain click still navigates
// (subsection) or collapses/expands (section header) untouched.
// ---------------------------------------------------------------------------
const DRAG_THRESHOLD_PX = 6

interface DragState {
  kind: 'category' | 'item'
  /** Section this drag belongs to (item drags only within this section) */
  catLabel: string
  /** Array index of the row being dragged, within its visible list */
  from: number
  /** Target insertion gap [0..count] while dragging */
  to: number
  /** Rows the dragged row is locked to while dragging (query scope) */
  rows: HTMLElement[]
}

/** Pointer coordinates where the potential drag began */
const pendingStart = ref<{ clientX: number; clientY: number } | null>(null)

const drag = ref<DragState | null>(null)
/** Set while a drag was committed just before the release click arrives */
let suppressClick = false

const dragTrack = useWindowPointerTrack({
  onMove: onDragMove,
  onUp: onDragUp,
  onCancel: onDragCancel,
})

function categoryRows(): HTMLElement[] {
  return Array.from(
    (propsRoot?.value?.querySelectorAll('.nd-scroll > .nd-group[data-nav-row]') ?? []) as unknown as HTMLElement[],
  )
}

/** Current insertion index [0..n] from the pointer Y over `rows` */
function targetBoundary(rows: HTMLElement[], clientY: number): number {
  let b = 0
  for (const el of rows) {
    const r = el.getBoundingClientRect()
    if (clientY > r.top + r.height / 2) b += 1
  }
  return b
}

function onDragMove(e: PointerEvent) {
  // No drag confirmed yet — test the movement threshold against the origin.
  if (!drag.value) {
    const p = pendingStart.value
    if (!p) return
    if (Math.abs(e.clientY - p.clientY) < DRAG_THRESHOLD_PX && Math.abs(e.clientX - p.clientX) < DRAG_THRESHOLD_PX) {
      return
    }
    // Threshold crossed — this is a genuine drag. Commit the pending state.
    if (pendingCat.value) startCategoryDrag(pendingCat.value)
    else if (pendingItem.value) startItemDrag(pendingItem.value)
    return
  }
  const d = drag.value
  const b = d.kind === 'category' ? targetBoundary(categoryRows(), e.clientY) : targetBoundary(d.rows, e.clientY)
  d.to = Math.max(0, Math.min(b, d.rows.length))
}

/**
 * Begins tracking a possible drag. Does nothing destructive on its own: until
 * the pointer moves beyond DRAG_THRESHOLD_PX the pending row does not start a
 * drag and the ordinary click proceeds normally.
 */
function beginPotential(row: HTMLElement, e: PointerEvent) {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || pendingStart.value) return
  // A fresh press is by definition not a lingering drag-release click.
  suppressClick = false
  pendingStart.value = { clientX: e.clientX, clientY: e.clientY }
  dragTrack.start()
}

// Pending row identities waiting for the threshold check.
const pendingCat = ref<HTMLElement | null>(null)
const pendingItem = ref<{ row: HTMLElement; catLabel: string } | null>(null)

function startCategoryDrag(row: HTMLElement) {
  const rows = categoryRows()
  if (rows.length < 2) return
  const from = rows.indexOf(row)
  if (from < 0) return
  drag.value = { kind: 'category', catLabel: row.dataset.navLabel ?? '', from, to: from, rows }
  clearPending()
}

function startItemDrag(p: { row: HTMLElement; catLabel: string }) {
  const groupEl = p.row.closest<HTMLElement>('.nd-group[data-nav-label]')
  const rows = groupEl ? Array.from(groupEl.querySelectorAll<HTMLElement>('.nd-item[data-nav-row]')) : []
  if (rows.length < 2) return
  const from = rows.indexOf(p.row)
  if (from < 0) return
  drag.value = { kind: 'item', catLabel: p.catLabel, from, to: from, rows }
  clearPending()
}

function onDragUp(_e: PointerEvent) {
  const d = drag.value
  const from = d?.from
  const b = d?.to
  const n = d?.rows.length ?? 0
  endDrag()
  if (d && b != null && from != null) {
    const to = b > from ? b - 1 : b
    if (to >= 0 && to < n && to !== from) {
      if (d.kind === 'category') emit('reorder-category', { from, to })
      else emit('reorder-item', { catLabel: d.catLabel, from, to })
    }
    // A real drag just happened — swallow the release click so the under-
    // pointer row/subsection does not navigate or toggle right after.
    suppressClick = true
  }
}

function onDragCancel() {
  endDrag()
  suppressClick = false
}

function clearPending() {
  pendingStart.value = null
  pendingCat.value = null
  pendingItem.value = null
}

function endDrag() {
  dragTrack.stop()
  clearPending()
  drag.value = null
}

/** Swallow a click that directly follows a real drag. */
function isSuppressedClick(): boolean {
  if (suppressClick) {
    suppressClick = false
    return true
  }
  return false
}

/** Section-header pressed — begin a potential drag of that section. */
function onHeadPointerDown(e: PointerEvent) {
  const head = (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.nd-group') as HTMLElement | null
  if (head) {
    pendingCat.value = head
    beginPotential(head, e)
  }
}

/** Subsection row pressed — begin a potential drag of that section item. */
function onItemPointerDown(e: PointerEvent) {
  const row = (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.nd-item') as HTMLElement | null
  if (!row) return
  const groupEl = row.closest<HTMLElement>('.nd-group[data-nav-label]')
  pendingItem.value = { row, catLabel: groupEl?.dataset.navLabel ?? '' }
  beginPotential(row, e)
}

const propsRoot = ref<HTMLElement | null>(null)

// ---------------------------------------------------------------------------
// Icons: route name -> icon (default: generic list icon for unknown items)
// ---------------------------------------------------------------------------
const ITEM_ICONS: Record<string, AppIconName> = {
  projects: 'kanban',
  processes: 'flow',
  planner: 'checklist',
  timesheet: 'calendar',
  employees: 'users',
  resources: 'cpu',
  users: 'user-circle',
  structure: 'org',
  'auto-create': 'sparkles',
  statuses: 'tag',
  permissions: 'key',
  audit: 'scroll',
  'system-console': 'kanban',
  'system-queue': 'list',
  'system-status': 'checklist',
  'system-settings': 'key',
  profile: 'user',
}

function iconFor(item: NavItem): AppIconName {
  return ITEM_ICONS[item.name] ?? 'list'
}

// ---------------------------------------------------------------------------
// Item icons from the asset catalog (Lucide defaults, overridable by mounted
// custom icons — see src/assets). Each item with `icon` resolves its SVG
// markup once (async, memoized in the asset module); while it is resolving or
// on a miss the legacy AppIcon fallback above is rendered, so navigation never
// waits on the fetch.
// ---------------------------------------------------------------------------
const itemIconSvg = ref<Record<string, string | null>>({})

function loadItemIcons(cats: NavCategory[]) {
  for (const cat of cats) {
    for (const item of cat.items) {
      const key = item.name
      if (!item.icon || itemIconSvg.value[key] !== undefined) continue
      // Mark the key as in-flight *before* the async hop: the watcher re-enters
      // on reorders and must not schedule duplicate resolutions.
      itemIconSvg.value[key] = null
      void resolveAssetWithCustom('icons', `${item.icon}.svg`).then((raw) => {
        itemIconSvg.value[key] = typeof raw === 'string' ? raw : null
      })
    }
  }
}

watch(() => props.categories, (cats) => loadItemIcons(cats), { immediate: true })
</script>

<template>
  <!-- Scrim for the narrow-screen (overlay) mode; invisible on desktop where
       the drawer is a real layout column -->
  <div
    class="nd-overlay"
    :class="{ 'nd-overlay--on': props.open }"
    @click="emit('close')"
  ></div>

  <aside
    ref="propsRoot"
    class="nd"
    :class="{
      'nd--open': props.open,
      'nd--dragging': drag != null,
    }"
    role="navigation"
    :aria-label="t('nav.sections')"
  >
    <div class="nd-inner">
      <!-- Drawer header: the only place the product brand lives. Closing the
           drawer is done by the burger (which turns into an ×), Escape, a
           menu item click, or the scrim on narrow screens -->
      <div class="nd-top">
        <div class="nd-brand">{{ props.brand }}</div>
      </div>

      <nav class="nd-scroll">
        <section
          v-for="cat in props.categories"
          :key="cat.label"
          class="nd-group"
          data-nav-row
          :class="{
            'nd-group--open': isOpen(cat),
          }"
          :data-nav-label="cat.label"
        >
          <button
            type="button"
            class="nd-group-head"
            :aria-expanded="isOpen(cat)"
            :title="t('common.dragHeaderTitle')"
            @pointerdown="onHeadPointerDown"
            @click="onHeadClick(cat)"
          >
            <span class="nd-group-title">{{ t(cat.label) }}</span>
            <AppIcon name="chevron-down" :size="16" class="nd-caret" />
          </button>
          <Transition
            :duration="320"
            @before-enter="onBeforeEnter"
            @enter="onEnter"
            @after-enter="onAfterClear"
            @before-leave="onBeforeLeave"
            @leave="onLeave"
            @after-leave="onAfterClear"
          >
            <div v-show="isOpen(cat)" :key="cat.label" class="nd-items-clip">
              <div class="nd-items">
                <a
                  v-for="item in cat.items"
                  :key="item.to"
                  :href="item.to"
                  draggable="false"
                  class="nd-item"
                  data-nav-row
                  :class="{
                    active: item.name === props.activeName,
                    'nd-item--dragsource': drag != null && drag.catLabel === cat.label && drag.kind === 'item',
                  }"
                  :aria-label="t(item.label)"
                  @pointerdown="onItemPointerDown"
                  @click="(e) => onItemNavigate(e, item)"
                >
                  <span
                    v-if="itemIconSvg[item.name]"
                    class="nd-item-icon"
                    aria-hidden="true"
                    v-html="itemIconSvg[item.name]"
                  ></span>
                  <AppIcon v-else :name="iconFor(item)" :size="22" />
                  <span class="nd-item-label">{{ t(item.label) }}</span>
                  <span v-if="item.badge" class="nd-badge">{{ item.badge }}</span>
                </a>
              </div>
            </div>
          </Transition>
        </section>
      </nav>
    </div>
  </aside>
</template>

<style scoped>
@import '../../../styles/tokens.css';

/* Desktop: the drawer is a real layout column. Its outer width animates
   between 0 and NAV_WIDTH, shifting the content column; the inner panel is
   fixed-width so items never reflow while the column opens. */
.nd {
  flex: none;
  height: 100%;
  width: 0;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
  transition:
    width 0.33s cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s linear 0.33s;
}

.nd--open {
  width: v-bind('NAV_WIDTH + "px"');
  visibility: visible;
  pointer-events: auto;
  /* visibility flips immediately on open, delayed 0.33s on close */
  transition:
    width 0.33s cubic-bezier(0.16, 1, 0.3, 1),
    visibility 0s;
}

/* Fixed inner width: content never squashes while the column animates */
.nd-inner {
  width: v-bind('NAV_WIDTH + "px"');
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ui-surface);
  color: var(--ui-text);
  border-right: 1px solid var(--ui-border);
}

/* Scrim: only in the narrow overlay mode (see media query below) */
.nd-overlay {
  display: none;
}

.nd-top {
  flex: none;
  display: flex;
  align-items: center;
  height: 64px;
  padding: 0 16px 0 20px;
  border-bottom: 1px solid var(--ui-surface-3);
}

.nd-brand {
  font-size: calc(var(--ui-font-scale, 1) * 20px);
  font-weight: 750;
  letter-spacing: 0.2px;
  color: var(--ui-text);
  white-space: nowrap;
}

.nd-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 10px 22px;
}

.nd-group {
  margin-bottom: 4px;
}

.nd-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 10px 9px;
  border: none;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
  transition: background var(--ui-duration);
}

.nd-group-head:hover {
  background: var(--ui-surface-2);
}

.nd-group-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--ui-text-faint);
  white-space: nowrap;
}

.nd-caret {
  color: var(--ui-text-faint);
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

.nd-group--open .nd-caret {
  transform: rotate(180deg);
}

/* Expand/collapse clip: the CONTAINER height animates (0 <-> full height),
   content only fades; overflow hidden guarantees items never move/squash */
.nd-items-clip {
  overflow: hidden;
  transition:
    height 0.3s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.22s ease;
  will-change: height;
}

.nd-items {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 0 8px;
}

.nd-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 12px;
  height: 42px;
  padding: 0 12px 0 16px;
  border-radius: 8px;
  color: var(--ui-text-2);
  text-decoration: none;
  font-size: calc(var(--ui-font-scale, 1) * 15px);
  font-family: inherit;
  transition: background var(--ui-duration), color var(--ui-duration);
}
.nd-item--dragsource {
  opacity: 0.55;
}
.nd-item :deep(svg) {
  color: var(--ui-text-faint);
  transition: color var(--ui-duration);
}

/* Asset-catalog icon (inline SVG markup): fixed 18px box; color flows through
   the same :deep(svg) rules as the legacy AppIcon above (faint → text-2 on
   hover → accent when active). */
.nd-item-icon {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  color: inherit;
}
.nd-item-icon :deep(svg) {
  width: 18px;
  height: 18px;
  display: block;
}

.nd-item:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}

.nd-item:hover :deep(svg) {
  color: var(--ui-text-2);
}

.nd-item.active {
  background: var(--ui-accent-soft);
  color: var(--ui-text);
  font-weight: 600;
}

.nd-item.active :deep(svg) {
  color: var(--ui-accent);
}

/* Thin accent bar on the left of the active item — quiet, not loud */
.nd-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 9px;
  bottom: 9px;
  width: 3px;
  border-radius: 2px;
  background: var(--ui-accent);
}

.nd-item-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nd-badge {
  flex: none;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 700;
  line-height: 1;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

/* ---------------------------------------------------------------------------
 * Narrow screens: the drawer becomes a classic overlay (fixed, slides over
 * the content with a scrim) — shifting the content is impractical there.
 * ---------------------------------------------------------------------------
 */
@media (max-width: 720px) {
  .nd-overlay {
    display: block;
    position: fixed;
    inset: 0;
    z-index: 34990;
    background: rgba(15, 23, 42, 0.45);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--ui-duration) ease;
  }

  .nd-overlay--on {
    opacity: 1;
    pointer-events: auto;
  }

  .nd {
    position: fixed;
    top: 0;
    left: 0;
    bottom: 0;
    z-index: 35000;
    width: min(280px, 92vw);
    height: auto;
    overflow: visible;
    visibility: visible;
    pointer-events: auto;
    transform: translateX(-104%);
    transition: transform 0.33s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .nd--open {
    width: min(280px, 92vw);
    transform: translateX(0);
    transition: transform 0.33s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .nd-inner {
    width: auto;
    box-shadow: var(--ui-shadow-lg);
  }
}

/* Custom dark-mode scrim (narrow mode only) */
:root[data-scheme='dark'] .nd-overlay {
  background: rgba(0, 0, 0, 0.55);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-scheme='light']) .nd-overlay {
    background: rgba(0, 0, 0, 0.55);
  }
}
</style>