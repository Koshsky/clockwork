<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { preloadPdfPreview, renderPdfPreview } from './previewPdf'
import type { PdfPreviewHandle } from './previewPdf'
import type { PdfExportProps } from './types'
import { fmtDate, toDate } from '../calendar'
import { t } from '@/i18n'
import { fmtDateRange } from '@/i18n/date'
import { viewSettings } from '@/settings'
import type { DiagramSnapshot, SnapshotPrintPage } from './snapshot'
import { printSnapshotPages } from './printPages'
import type { PdfGanttGroup } from './pdfRenderer'

const props = withDefaults(defineProps<PdfExportProps>(), {
  groups: () => [],
  origin: '',
  unit: 'day',
  pageTitle: undefined,
  ownerId: null,
  scope: 'tasks',
  rowHeight: null,
  periodFrom: '',
  periodTo: '',
  scale: 1,
  resources: () => [],
  calendar: () => [],
})

const rootEl = ref<HTMLElement | null>(null)
const snapshotGroups = ref<PdfGanttGroup[] | null>(null)
const sourceGroups = computed(() => snapshotGroups.value ?? props.groups ?? [])
let snapshot: DiagramSnapshot | null = null
const opening = ref(false)

/** Min/max dates from the data — period fallback until the page's visible window arrives */
const dataRange = computed(() => {
  let min = ''
  let max = ''
  const touch = (d?: string | null) => {
    if (!d) return
    if (!min || d < min) min = d
    if (!max || d > max) max = d
  }
  for (const g of sourceGroups.value) {
    touch(g.start_date)
    touch(g.end_date)
    for (const r of g.rows ?? []) {
      touch(r.start_date)
      touch(r.end_date)
    }
    for (const m of g.milestones ?? []) touch(m.date)
  }
  const now = fmtDate(new Date())
  if (!min) min = now
  if (!max) max = now
  return { from: min, to: max }
})

/** Print period: the page's visible window; fallback — the data range */
function resolvePeriod(): { from: string; to: string } {
  const { periodFrom, periodTo } = props
  if (periodFrom && periodTo && periodFrom <= periodTo) {
    return { from: periodFrom, to: periodTo }
  }
  return dataRange.value
}

/** The period came from the page's visible window (not the data fallback) */
const periodFromPage = computed(
  () => Boolean(props.periodFrom && props.periodTo && props.periodFrom <= props.periodTo),
)

/** Human-readable period string for the modal (dd.mm.yyyy — dd.mm.yyyy) */
const periodLabel = computed(() => {
  const p = resolvePeriod()
  return fmtDateRange(toDate(p.from), toDate(p.to))
})

/**
 * Title printed in the PDF footer: an explicit prop wins (pages pass their own
 * translated title), otherwise the dialog's default in the active language.
 * Resolved in a computed so a language switch re-renders it.
 */
const pdfTitle = computed(() => props.pageTitle || t('pdf.dialog.defaultPageTitle'))

/** Fallback hint: no period from the page, but there is data to print */
const periodFallbackHint = computed(
  () => open.value && !previewLoading.value && !periodFromPage.value && visibleGroups.value.length > 0,
)

/**
 * Print settings: process filters and appearance; persisted in the session.
 * The period comes from the page (periodFrom/periodTo props).
 */
const thicknessEdited = ref(false)
const settings = ref({
  onlyMine: false,
  hiddenProjects: [] as number[],
  selectedNames: [] as string[],
  showMilestones: true,
  showTodayLine: true,
  showResources: true,
  // Bar thickness (px): the row automatically = bar + 2px; starts from the rowHeight prop
  barThickness: (props.rowHeight ?? 26) - 2,
})

/** Filter list expansion state (UI state) */
const projectsOpen = ref(false)
const namesOpen = ref(false)

/** Unique projects from groups/rows (for the "Hide projects" filter) */
const projects = computed(() => {
  const seen = new Map<number, string>()
  const add = (id?: number, code?: string) => {
    if (id == null) return
    if (!seen.has(id)) seen.set(id, code || t('pdf.dialog.projectFallback', { id }))
  }
  for (const g of sourceGroups.value) {
    add(g.project_id, g.code)
    for (const r of g.rows ?? []) add(r.project_id, r.title)
  }
  return [...seen.entries()].map(([id, code]) => ({ id, code })).sort((a, b) => a.code.localeCompare(b.code, 'ru'))
})

/** Name filter label: same for tasks and processes */
const nameFilterLabel = computed(() => t('pdf.dialog.processes'))

/** Scope-dependent print modal configuration.
 *  Printing does not depend on RBAC rights: the options are derived from the data.
 *  "Only my processes" matters when the printed set includes foreign
 *  processes (owner_id != current user); with "only mine" enabled the
 *  name filter is not needed. */
const hasForeignProcesses = computed(() =>
  sourceGroups.value.some((g) => g.owner_id != null && g.owner_id !== props.ownerId),
)
const showNameFilter = computed(() => props.scope !== 'projects' && !settings.value.onlyMine)
const showMilestonesOption = computed(() => props.scope === 'tasks')
const showResourcesOption = computed(() => props.scope === 'tasks')
/** Name/project filter level: tasks — groups, processes/projects — rows */
const filterLevel = computed<'group' | 'row'>(() => (props.scope === 'tasks' ? 'group' : 'row'))

/** Name filter options: group titles (tasks) or row titles (processes/projects) */
const nameOptions = computed(() => {
  const names = new Set<string>()
  if (filterLevel.value === 'row') {
    for (const g of sourceGroups.value) for (const r of g.rows ?? []) if (r.title) names.add(r.title)
  } else {
    for (const g of sourceGroups.value) if (g.title) names.add(g.title)
  }
  return [...names].sort((a, b) => a.localeCompare(b, 'ru'))
})

/**
 * Groups included in the print: filters are applied in a chain.
 * The filter level ("groups" for tasks, "rows" for processes/projects)
 * is derived from the scope.
 */
const visibleGroups = computed(() => {
  let list = sourceGroups.value
  const level = filterLevel.value
  // "Only my processes" (only vp sees it): by group or row owner
  if (settings.value.onlyMine && props.ownerId != null) {
    if (level === 'group') {
      list = list.filter((g) => g.owner_id === props.ownerId)
    } else {
      list = list
        .map((g) => ({ ...g, rows: (g.rows ?? []).filter((r) => r.owner_id === props.ownerId) }))
        .filter((g) => (g.rows?.length ?? 0) > 0)
    }
  }
  // "Hide projects": remove project groups and project rows
  if (settings.value.hiddenProjects.length) {
    const hidden = new Set(settings.value.hiddenProjects)
    list = list.filter((g) => g.project_id == null || !hidden.has(g.project_id))
    if (level === 'row') {
      list = list.map((g) => ({
        ...g,
        rows: (g.rows ?? []).filter((r) => r.project_id == null || !hidden.has(r.project_id)),
      }))
    }
  }
  // Name filter (multi-select): groups or rows (except the projects scope)
  if (showNameFilter.value && settings.value.selectedNames.length) {
    const sel = new Set(settings.value.selectedNames)
    if (level === 'group') {
      list = list.filter((g) => sel.has(g.title))
    } else {
      list = list
        .map((g) => ({ ...g, rows: (g.rows ?? []).filter((r) => sel.has(r.title)) }))
        .filter((g) => (g.rows?.length ?? 0) > 0)
    }
  }
  return list.filter((group) => group.rows.length > 0 || (props.scope === 'tasks' && settings.value.showMilestones && (group.milestones?.length ?? 0) > 0))
})

/** Everything filtered out — preview is empty, printing unavailable */
const previewEmpty = computed(
  () => !previewLoading.value && !previewError.value && visibleGroups.value.length === 0,
)

const open = ref(false)
const busy = ref(false)
const previewError = ref<string | null>(null)
/** The last render cut the period (P-07): the range was wider than the page */
const truncatedWarning = ref(false)
const previewLoading = ref(false)
const pageCount = ref(0)
const currentBytes = ref<Uint8Array | null>(null)
let currentPages: SnapshotPrintPage[] = []

const filename = computed(() => `gantt-${fmtDate(new Date())}.pdf`)

const previewEl = ref<HTMLElement | null>(null)
let previewHandle: PdfPreviewHandle | null = null

/** Params of the last successful render (to avoid regenerating needlessly) */
let renderedParams = ''
let genToken = 0
let genTimer: ReturnType<typeof setTimeout> | null = null

/** Current render key: filters + period/width from the page */
function renderKey(): string {
  const p = resolvePeriod()
  return JSON.stringify({ ...settings.value, from: p.from, to: p.to })
}

/**
 * Warm loading of the capture and preview modules: starts on the first click and loads chunks IN PARALLEL, so the
 * first open does not wait for each chunk to load sequentially.
 * Idempotent: repeated calls return the same promise.
 */
let warmupPromise: Promise<unknown> | null = null
function warmup(): Promise<unknown> {
  if (!warmupPromise) {
    const p = Promise.all([import('./snapshot'), preloadPdfPreview()])
    // Prevent an "unhandled" rejection before generate() picks it up
    p.catch(() => {})
    warmupPromise = p
  }
  return warmupPromise
}

/**
 * Preview generation: one generator in flight (single-flight).
 * Repeated generate() calls while running do not start a new render —
 * they set a "redo" flag: after the current render finishes, it runs
 * again with the up-to-date settings. This rules out token races
 * (when a deferred call invalidated a fresh preview and left a stuck
 * "Preparing preview…" placeholder).
 */
let runInProgress = false
let runPending = false
let runPromise: Promise<void> | null = null

function generate(force = false): Promise<void> {
  if (runInProgress) {
    runPending = true
    return runPromise ?? Promise.resolve()
  }
  const p = runAll(force)
  runPromise = p
  return p
}

async function runAll(force: boolean) {
  runInProgress = true
  try {
    do {
      runPending = false
      await generateOnce(force)
      force = false
    } while (runPending && open.value)
  } finally {
    runInProgress = false
    runPromise = null
    previewLoading.value = false
  }
}

/** One pass: frozen DOM → PDF image → preview page rendering */
async function generateOnce(force: boolean) {
  const params = renderKey()
  // Params did not change — no render needed. Early exit WITHOUT a token change:
  // the current render (if running) should finish calmly.
  if (!force && params === renderedParams && currentBytes.value) return
  // All data filtered out — preview is empty, printing unavailable
  if (visibleGroups.value.length === 0) {
    previewError.value = null
    truncatedWarning.value = false
    pageCount.value = 0
    currentBytes.value = null
    currentPages = []
    return
  }
  previewLoading.value = true
  previewError.value = null
  const token = ++genToken
  try {
    // Modules load in parallel (on the first click — warmup); repeated
    // calls find them cached and do not wait for loading.
    await warmup()
    if (!snapshot) throw new Error('Missing diagram snapshot')
    const { snapshotPdf } = await import('./snapshot')
    const result = await snapshotPdf(snapshot, {
      extent: 'selection',
      cancelled: () => !open.value || params !== renderKey(),
      groups: visibleGroups.value,
      scope: props.scope,
      showMilestones: settings.value.showMilestones,
      showTodayLine: settings.value.showTodayLine,
      showResources: settings.value.showResources,
      style: 'color',
      barThickness: settings.value.barThickness,
    }, pdfTitle.value)
    if (token !== genToken) return
    currentBytes.value = result.bytes
    currentPages = result.pages
    truncatedWarning.value = false
    renderedParams = params

    const el = previewEl.value
    if (el) {
      previewHandle?.destroy()
      previewHandle = null
      const handle = await renderPdfPreview(result.bytes, el)
      if (token !== genToken) {
        handle.destroy()
        return
      }
      previewHandle = handle
      pageCount.value = handle.pageCount
    }
  } catch {
    if (token === genToken && params === renderKey()) {
      previewError.value = t('pdf.dialog.captureError')
      truncatedWarning.value = false
      pageCount.value = 0
      currentBytes.value = null
      currentPages = []
    }
  }
}

/** Live preview update (debounced) on settings changes */
function scheduleGenerate() {
  if (genTimer != null) clearTimeout(genTimer)
  genTimer = setTimeout(() => {
    genTimer = null
    void generate()
  }, 400)
}

watch(settings, scheduleGenerate, { deep: true })

/**
 * The period/width from the page arrive debounced (visible-range emit ~150 ms):
 * if the modal is opened right after scrolling, generation on open could have
 * used stale values — regenerate the preview once the props arrive.
 */
watch(
  () => [props.periodFrom, props.periodTo] as const,
  () => {
    if (open.value) scheduleGenerate()
  },
)

async function openDialog() {
  if (busy.value || opening.value || open.value) return
  opening.value = true
  snapshot?.dispose()
  snapshot = null
  snapshotGroups.value = null
  renderedParams = ''
  previewError.value = null
  truncatedWarning.value = false
  pageCount.value = 0
  currentBytes.value = null
  currentPages = []
  try {
    await document.fonts.ready
    const target = props.captureTarget ? props.captureTarget() : rootEl.value?.closest('section')?.querySelector<HTMLElement>('.tg-scroll')
    if (!target) throw new Error('Missing diagram viewport')
    const { freezeDiagram } = await import('./snapshot')
    snapshot = freezeDiagram(target, true)
    snapshotGroups.value = JSON.parse(JSON.stringify(props.groups ?? [])) as PdfGanttGroup[]
    if (!thicknessEdited.value) settings.value.barThickness = snapshot.barThickness
    open.value = true
    void nextTick(() => void generate(true))
  } catch {
    previewError.value = t('pdf.dialog.captureError')
    open.value = true
  } finally {
    opening.value = false
  }
}

function closeDialog() {
  if (busy.value) return
  open.value = false
  snapshot?.dispose()
  snapshot = null
  snapshotGroups.value = null
  runPending = false
  genToken++
  if (genTimer != null) {
    clearTimeout(genTimer)
    genTimer = null
  }
  previewHandle?.destroy()
  previewHandle = null
  previewLoading.value = false
  previewError.value = null
  truncatedWarning.value = false
  currentBytes.value = null
  currentPages = []
}

function download(bytes: Uint8Array, name: string) {
  // Copy into a separate ArrayBuffer: TS does not allow a Blob part from Uint8Array<ArrayBufferLike>
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy.buffer], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Downloads the file matching the current preview (without regenerating) */
async function onDownload() {
  if (busy.value || previewEmpty.value) return
  const params = renderKey()
  let bytes = currentBytes.value
  if (!bytes || params !== renderedParams) {
    busy.value = true
    try {
      await generate(true)
      bytes = currentBytes.value
    } finally {
      busy.value = false
    }
  }
  if (!bytes) return
  download(bytes, filename.value)
  closeDialog()
}

/** Prepares printing: generates the PDF and sends it to the browser print dialog */
async function onPrint() {
  if (busy.value || previewEmpty.value) return
  const params = renderKey()
  let bytes = currentBytes.value
  if (!bytes || params !== renderedParams) {
    busy.value = true
    try {
      await generate(true)
      bytes = currentBytes.value
    } finally {
      busy.value = false
    }
  }
  if (!bytes) return
  busy.value = true
  try {
    await printSnapshotPages(currentPages)
  } catch {
    previewError.value = t('pdf.dialog.captureError')
    return
  } finally {
    busy.value = false
  }
  closeDialog()
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && open.value) closeDialog()
}

/** Global Ctrl/Cmd+P/S (intercepted in MainLayout) — open the print preparation modal */
function onPrintRequest() {
  if (!open.value) openDialog()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  window.addEventListener('app:print-request', onPrintRequest)
})

onBeforeUnmount(() => {
  snapshot?.dispose()
  if (genTimer != null) clearTimeout(genTimer)
  previewHandle?.destroy()
  document.removeEventListener('keydown', onKeydown)
  window.removeEventListener('app:print-request', onPrintRequest)
})
</script>

<template>
  <div ref="rootEl" class="pe">
    <!-- Visible toolbar trigger above the diagram (gated by the view settings
         "Export charts"). Ctrl/Cmd+P/S always works regardless of this flag. -->
    <button
      v-if="viewSettings.showPdfButtons"
      type="button"
      class="pe-open"
      :disabled="opening"
      @click="openDialog"
    >
      <span class="pe-open-icon" aria-hidden="true">⤓</span>
      {{ t('pdf.dialog.openButton') }}
    </button>
    <Teleport to="body">
      <div v-if="open" class="pe-overlay" @mousedown.self="closeDialog">
        <div class="pe-modal" role="dialog" aria-modal="true" :aria-label="t('pdf.dialog.ariaTitle')">
          <div class="pe-head">
            <h3 class="pe-title">{{ t('pdf.dialog.title') }}</h3>
            <button type="button" class="pe-close" :aria-label="t('common.close')" @click="closeDialog">×</button>
          </div>

          <div class="pe-body">
            <div class="pe-settings">
              <div class="pe-field">
                <span class="pe-label">{{ t('pdf.dialog.barThickness') }}</span>
                <div class="pe-range-row">
                  <input v-model.number="settings.barThickness" type="range" min="16" max="64" step="4" class="pe-range" @input="thicknessEdited = true" />
                  <span class="pe-range-value">{{ settings.barThickness }}px</span>
                </div>
              </div>

              <label v-if="hasForeignProcesses" class="pe-field">
                <span class="pe-toggle">
                  <input v-model="settings.onlyMine" type="checkbox" class="pe-checkbox" />
                  <span class="pe-label">{{ t('pdf.dialog.onlyMine') }}</span>
                </span>
              </label>

              <label v-if="showMilestonesOption" class="pe-field">
                <span class="pe-toggle">
                  <input v-model="settings.showMilestones" type="checkbox" class="pe-checkbox" />
                  <span class="pe-label">{{ t('pdf.dialog.showMilestones') }}</span>
                </span>
              </label>

              <label class="pe-field">
                <span class="pe-toggle">
                  <input v-model="settings.showTodayLine" type="checkbox" class="pe-checkbox" />
                  <span class="pe-label">{{ t('pdf.dialog.showTodayLine') }}</span>
                </span>
              </label>

              <label v-if="showResourcesOption" class="pe-field">
                <span class="pe-toggle">
                  <input v-model="settings.showResources" type="checkbox" class="pe-checkbox" />
                  <span class="pe-label">{{ t('pdf.dialog.showResources') }}</span>
                </span>
              </label>

              <div v-if="showNameFilter" class="pe-field">
                <button type="button" class="pe-filters-toggle" @click="namesOpen = !namesOpen">
                  <span>{{ nameFilterLabel }}</span>
                  <span v-if="settings.selectedNames.length" class="pe-filters-count">{{ settings.selectedNames.length }}</span>
                  <span class="pe-caret">{{ namesOpen ? '▾' : '▸' }}</span>
                </button>
                <div v-if="namesOpen" class="pe-filter-list">
                  <p v-if="!nameOptions.length" class="pe-hint">{{ t('common.noData') }}</p>
                  <label v-for="name in nameOptions" :key="name" class="pe-filter-item">
                    <input v-model="settings.selectedNames" type="checkbox" :value="name" class="pe-checkbox" />
                    <span class="pe-filter-label">{{ name }}</span>
                  </label>
                </div>
              </div>

              <div class="pe-field">
                <button type="button" class="pe-filters-toggle" @click="projectsOpen = !projectsOpen">
                  <span>{{ t('pdf.dialog.hideProjects') }}</span>
                  <span v-if="settings.hiddenProjects.length" class="pe-filters-count">{{ settings.hiddenProjects.length }}</span>
                  <span class="pe-caret">{{ projectsOpen ? '▾' : '▸' }}</span>
                </button>
                <div v-if="projectsOpen" class="pe-filter-list">
                  <p v-if="!projects.length" class="pe-hint">{{ t('pdf.dialog.noProjects') }}</p>
                  <label v-for="pr in projects" :key="pr.id" class="pe-filter-item">
                    <input v-model="settings.hiddenProjects" type="checkbox" :value="pr.id" class="pe-checkbox" />
                    <span class="pe-filter-label">{{ pr.code }}</span>
                  </label>
                </div>
              </div>

              <div class="pe-file">
                <span class="pe-file-label">{{ t('pdf.dialog.printPeriod') }}</span>
                <span class="pe-file-name">{{ periodLabel }}</span>
                <span v-if="!periodFromPage" class="pe-hint">{{ t('pdf.dialog.periodFromData') }}</span>
              </div>

              <div class="pe-file">
                <span class="pe-file-label">{{ t('pdf.dialog.file') }}</span>
                <span class="pe-file-name">{{ filename }}</span>
              </div>
            </div>

            <div class="pe-preview-area">
              <div v-if="periodFallbackHint" class="pe-period-hint">
                {{ t('pdf.dialog.periodFallbackHint') }}
              </div>
              <div v-else-if="!previewLoading && truncatedWarning" class="pe-period-hint pe-truncate-hint" role="status">
                {{ t('pdf.dialog.truncatedHint') }}
              </div>
              <div class="pe-preview-head">
                <span class="pe-pages-count">{{ t('pdf.dialog.pages', { count: pageCount }) }}</span>
                <span v-if="previewLoading" class="pe-updating">{{ t('pdf.dialog.updating') }}</span>
              </div>
              <div class="pe-preview-box">
                <div ref="previewEl" class="pe-pages"></div>
                <div v-if="previewLoading" class="pe-msg"><span class="pe-spinner" /> {{ t('pdf.dialog.preparing') }}</div>
                <div v-else-if="previewError" class="pe-msg pe-msg-error">{{ previewError }}</div>
                <div v-else-if="previewEmpty" class="pe-msg">{{ t('pdf.dialog.empty') }}</div>
              </div>
            </div>
          </div>

          <div class="pe-actions">
            <button type="button" class="pe-btn-cancel" @click="closeDialog">{{ t('common.cancel') }}</button>
            <button type="button" class="pe-btn-download" :disabled="busy || previewEmpty || previewLoading || !!previewError" @click="onDownload">
              {{ t('pdf.dialog.download') }}
            </button>
            <button type="button" class="pe-btn-primary" :disabled="busy || previewEmpty || previewLoading || !!previewError" @click="onPrint">
              <span v-if="busy" class="pe-spinner" />
              {{ t('pdf.dialog.print') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.pe-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: none;
  border-radius: 8px;
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  font-family: inherit;
  color: #fff;
  background: #1a73e8;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
}
.pe-btn:hover:not(:disabled) {
  background: #1765cc;
}
.pe-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* Visible toolbar trigger placed above the diagram (the pages put <PdfExport>
   at the top of their area; this button is the on-screen affordance). */
.pe-open {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  color: var(--ui-text);
  padding: 9px 16px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.pe-open:hover {
  background: var(--ui-surface-2);
  border-color: var(--ui-border-stronger);
}
.pe-open-icon {
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1;
  color: var(--ui-accent);
}


/* === Modal === */
.pe-overlay {
  position: fixed;
  inset: 0;
  z-index: 40000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  padding: 16px;
}
.pe-modal {
  width: 100%;
  max-width: 1000px;
  max-height: 92vh;
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pe-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid #e8e8e8;
}
.pe-title {
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: #2c3e50;
  margin: 0;
}
.pe-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 22px);
  line-height: 1;
  color: #999;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.pe-close:hover {
  background: #f2f2f2;
  color: #333;
}

.pe-body {
  display: flex;
  gap: 16px;
  padding: 16px;
  min-height: 0;
  flex: 1;
}

/* === Settings === */
.pe-settings {
  flex: 0 0 260px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  min-height: 0;
}
.pe-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pe-label {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: #444;
  font-weight: 500;
}
.pe-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #ddd;
  border-radius: 8px;
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: #333;
  background: #fff;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.pe-input:focus {
  border-color: #1a73e8;
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.pe-hint {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: #999;
}
.pe-style-row {
  display: flex;
  align-items: center;
  gap: 16px;
}
.pe-style-opt {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: #333;
  cursor: pointer;
}
.pe-range-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pe-range {
  flex: 1;
  accent-color: #1a73e8;
}
.pe-range-value {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: #555;
  min-width: 40px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.pe-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}
.pe-checkbox {
  width: 16px;
  height: 16px;
  accent-color: #1a73e8;
  cursor: pointer;
  flex-shrink: 0;
}

/* === Process filters === */
.pe-filters-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 1px solid #e3e6ea;
  background: #f8f9fa;
  border-radius: 8px;
  padding: 8px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 500;
  font-family: inherit;
  color: #333;
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, border-color 0.15s;
}
.pe-filters-toggle:hover {
  background: #eef2f7;
  border-color: #cfd6de;
}
.pe-filters-count {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #1a73e8;
  color: #fff;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pe-caret {
  margin-left: auto;
  color: #888;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
}
.pe-filter-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  padding: 6px;
  max-height: 180px;
  overflow-y: auto;
  background: #fff;
}
.pe-filter-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.pe-filter-item:hover {
  background: #f2f6fc;
}
.pe-filter-label {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: #333;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pe-file {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding-top: 14px;
  border-top: 1px solid #f0f0f0;
}
.pe-file-label {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: #999;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.pe-file-name {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: #333;
  word-break: break-all;
}
.pe-file-sub {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: #666;
}
.pe-period-hint {
  padding: 8px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: #b45309;
  background: #fef3c7;
  border-bottom: 1px solid #fde68a;
}
/* Wide period truncated to the page width (P-07) */
.pe-truncate-hint {
  color: #b3261e;
  background: #fdecea;
  border-bottom-color: #f7c8c4;
}

/* === Preview === */
.pe-preview-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid #e8e8e8;
  border-radius: 10px;
  overflow: hidden;
  background: #f4f6f9;
}
.pe-preview-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid #e8e8e8;
  background: #fff;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: #666;
}
.pe-updating {
  color: #1a73e8;
}
.pe-preview-box {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
.pe-pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.pe-msg {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: #666;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  background: #f4f6f9;
}
.pe-msg-error {
  color: #d93025;
}
.pe-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(26, 115, 232, 0.25);
  border-top-color: #1a73e8;
  border-radius: 50%;
  animation: pe-spin 0.7s linear infinite;
  display: inline-block;
  flex-shrink: 0;
}
@keyframes pe-spin {
  to {
    transform: rotate(360deg);
  }
}

/* === Actions === */
.pe-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 16px;
  border-top: 1px solid #e8e8e8;
}
.pe-btn-cancel,
.pe-btn-primary {
  border: none;
  border-radius: 8px;
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pe-btn-cancel {
  background: #f2f2f2;
  color: #444;
}
.pe-btn-cancel:hover {
  background: #e6e6e6;
}
.pe-btn-primary {
  background: #1a73e8;
  color: #fff;
}
.pe-btn-download {
  border: none;
  border-radius: 8px;
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: background 0.15s, opacity 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: #e8f0fe;
  color: #1a73e8;
}
.pe-btn-download:hover:not(:disabled) {
  background: #d2e3fc;
}
.pe-btn-download:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.pe-btn-primary:hover:not(:disabled) {
  background: #1765cc;
}
.pe-btn-primary:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>

<!-- Preview pages are created by script outside Vue — styles are not hidden under scoped -->
<style>
.pe-page {
  position: relative;
  background: #fff;
  border-radius: 4px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
}
.pe-page-canvas {
  display: block;
  border-radius: 4px;
}
.pe-page-num {
  position: absolute;
  top: -9px;
  right: 8px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: #1a73e8;
  color: #fff;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
</style>
