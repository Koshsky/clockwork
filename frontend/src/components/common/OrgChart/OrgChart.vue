<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../../i18n'
import { fullName } from '../../../utils/fullName'
import { presetLabelFromCatalog } from '../../../utils/presets'
import { buildOrgForest, buildManagerTeams, CARD_WIDTH, TEAM_PAGE_SIZE, TEAM_PREVIEW_SIZE, initialExpanded, layoutOrgChart, visibleChartLinks, visibleChartNodes } from './layout'
import OrgTeamList from './OrgTeamList.vue'
import AppIcon from '../AppIcon/AppIcon.vue'
import type { ChartViewport } from './layout'
import type { OrgChartProps } from './types'

const props = withDefaults(defineProps<OrgChartProps>(), { stateKey: '', presets: () => [] })
const forest = computed(() => buildOrgForest(props.employees))
const teams = computed(() => buildManagerTeams(forest.value))
const teamPages = ref<Record<string, number>>({})
const expanded = ref(new Set<number>())
const selected = ref<number | null>(null)
const viewport = ref<HTMLElement>()
const view = ref<ChartViewport>({ left: 0, top: 0, width: 900, height: 520 })
const layout = computed(() => layoutOrgChart(forest.value, expanded.value, teamPages.value, teams.value))
const inset = computed(() => Math.max(0, (view.value.width - layout.value.width) / 2))
const rendered = computed(() => visibleChartNodes(layout.value, view.value))
const paths = computed(() => visibleChartLinks(layout.value, view.value))
const person = computed(() => selected.value == null ? undefined : forest.value.nodes.get(selected.value))
const selectedOwner = computed(() => person.value?.children.length ? person.value.id : person.value?.parent)
const nameOf = (id: number) => { const user = forest.value.nodes.get(id)?.user; return fullName(user).trim() || user?.name || user?.username || `#${id}` }
const initialsOf = (id: number) => nameOf(id).split(/\s+/).slice(0, 2).map((part) => [...part][0]).join('').toUpperCase()
let observer: ResizeObserver | undefined
let frame = 0
let ready = false
let storageTimer: ReturnType<typeof setTimeout> | undefined

function persist() {
  if (!props.stateKey || !ready || !forest.value.nodes.size) return
  try {
    sessionStorage.setItem(props.stateKey, JSON.stringify({ version: 2, teamPages: teamPages.value, expanded: [...expanded.value], selected: selected.value, left: view.value.left, top: view.value.top }))
  } catch { /* A full or unavailable session store must not block the chart. */ }
}
function measure() {
  const element = viewport.value
  if (!element) return
  view.value = { left: element.scrollLeft, top: element.scrollTop, width: element.clientWidth, height: element.clientHeight }
}
function onScroll() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    measure()
    clearTimeout(storageTimer)
    storageTimer = setTimeout(persist, 200)
  })
}
function center(id?: number) {
  let targetId: number | undefined = id ?? selected.value ?? teams.value.roots[0]
  while (targetId != null && !layout.value.byId.has(targetId)) targetId = forest.value.nodes.get(targetId)?.parent ?? undefined
  const target = (targetId == null ? undefined : layout.value.byId.get(targetId)) ?? layout.value.byId.get(teams.value.roots[0] ?? -1)
  if (target && viewport.value) {
    viewport.value.scrollLeft = target.x + inset.value - (viewport.value.clientWidth - CARD_WIDTH) / 2
    viewport.value.scrollTop = Math.max(0, target.y - 32)
    measure()
  }
}
async function keepAnchor(id: number, change: () => void) {
  measure()
  const previous = layout.value.byId.get(id)
  const offset = previous ? { x: previous.x + inset.value - view.value.left, y: previous.y - view.value.top } : undefined
  change()
  await nextTick()
  const updated = layout.value.byId.get(id)
  if (updated && offset && viewport.value) {
    viewport.value.scrollLeft = updated.x + inset.value - offset.x
    viewport.value.scrollTop = updated.y - offset.y
  }
  measure()
  persist()
}
async function toggle(id: number) {
  await keepAnchor(id, () => {
    const next = new Set(expanded.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    expanded.value = next
  })
}
async function setTeamPage(id: number | 'unassigned', page: number) {
  const change = () => {
    const next = { ...teamPages.value }
    if (page < 0) delete next[id]
    else next[id] = page
    teamPages.value = next
  }
  if (id === 'unassigned') { change(); persist() }
  else await keepAnchor(id, change)
}
async function resetLevels() {
  expanded.value = initialExpanded(forest.value)
  selected.value = null
  await nextTick()
  center(teams.value.roots[0])
  persist()
}
function select(id: number) { measure(); selected.value = id; persist() }
async function initialize() {
  if (!forest.value.nodes.size) return
  ready = false
  expanded.value = initialExpanded(forest.value)
  selected.value = null
  teamPages.value = {}
  let restored: { left: number; top: number } | undefined
  if (props.stateKey) {
    try {
      const saved = JSON.parse(sessionStorage.getItem(props.stateKey) ?? 'null') as { version?: unknown; teamPages?: unknown; expanded?: unknown; selected?: unknown; left?: unknown; top?: unknown } | null
      if (saved?.version === 2) {
        if (Array.isArray(saved.expanded)) expanded.value = new Set(saved.expanded.filter((id): id is number => typeof id === 'number' && (teams.value.children.get(id)?.length ?? 0) > 0))
        if (typeof saved?.selected === 'number' && forest.value.nodes.has(saved.selected)) selected.value = saved.selected
        if (typeof saved?.left === 'number' && Number.isFinite(saved.left) && typeof saved.top === 'number' && Number.isFinite(saved.top)) restored = { left: saved.left, top: saved.top }
        if (saved.teamPages && typeof saved.teamPages === 'object') {
          const pages: Record<string, number> = {}
          for (const [key, value] of Object.entries(saved.teamPages)) {
            const count = key === 'unassigned' ? teams.value.unassigned.length : teams.value.members.get(Number(key))?.length ?? 0
            if (count > TEAM_PREVIEW_SIZE && typeof value === 'number' && Number.isInteger(value) && value >= 0) pages[key] = Math.min(value, Math.ceil(count / TEAM_PAGE_SIZE) - 1)
          }
          teamPages.value = pages
        }
      }
    } catch { /* Invalid saved state falls back to the initial overview. */ }
  }
  await nextTick()
  measure()
  if (restored && viewport.value) { viewport.value.scrollLeft = restored.left; viewport.value.scrollTop = restored.top; measure() }
  else center(teams.value.roots[0])
  ready = true
}
watch(() => props.employees, () => { persist(); void initialize() })
watch(viewport, (element, previous) => {
  if (previous) observer?.unobserve(previous)
  if (element) observer?.observe(element)
})
onMounted(() => {
  observer = new ResizeObserver(() => {
    const oldWidth = view.value.width
    measure()
    if (ready && oldWidth !== view.value.width) center(person.value?.id ?? teams.value.roots[0])
  })
  if (viewport.value) observer.observe(viewport.value)
  void initialize()
})
onBeforeUnmount(() => { measure(); persist(); clearTimeout(storageTimer); cancelAnimationFrame(frame); observer?.disconnect() })
</script>

<template>
  <div class="oc">
    <div class="oc-toolbar">
      <span class="oc-hint">{{ t('adminUsers.structure.chartHint') }}</span>
      <div class="oc-toolbar-actions"><button type="button" class="oc-button" @click="resetLevels">{{ t('adminUsers.structure.resetLevels') }}</button>
      <button type="button" class="oc-button" :disabled="!teams.roots.length" @click="center()">{{ t(person && selectedOwner != null ? 'adminUsers.structure.centerSelected' : 'adminUsers.structure.center') }}</button></div>
    </div>
    <p v-if="forest.issues" class="oc-warning" role="status">{{ t('adminUsers.structure.incomplete', { count: forest.issues }) }}</p>
    <div v-if="teams.roots.length" ref="viewport" class="oc-viewport" tabindex="0" role="region" :style="{ height: `${Math.min(600, Math.max(280, layout.height))}px` }" :aria-label="t('adminUsers.structure.chart')" @scroll.passive="onScroll">
      <div class="oc-canvas" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
        <svg class="oc-links" :width="view.width" :height="view.height" aria-hidden="true">
          <g :transform="`translate(${inset - view.left},${-view.top})`"><path v-for="(path, index) in paths" :key="index" :d="path" /></g>
        </svg>
        <article
          v-for="node in rendered" :key="node.id" class="oc-node" :class="{ selected: selectedOwner === node.id }"
          :style="{ left: `${node.x + inset}px`, top: `${node.y}px`, width: `${CARD_WIDTH}px`, height: `${node.height}px` }"
        >
          <button type="button" class="oc-person" :aria-pressed="selected === node.id" :title="nameOf(node.id)" @click="select(node.id)">
            <span class="oc-avatar" aria-hidden="true">{{ initialsOf(node.id) }}</span>
            <span class="oc-person-text"><span class="oc-name">{{ nameOf(node.id) }}</span><span class="oc-position">{{ forest.nodes.get(node.id)?.user.position || t('adminUsers.structure.noPosition') }}</span></span>
          </button>
          <OrgTeamList
            :members="teams.members.get(node.id) ?? []" :page="teamPages[node.id] ?? -1" :selected-id="selected"
            :group-name="nameOf(node.id)" @select="select" @update:page="setTeamPage(node.id, $event)"
          />
          <button
            v-if="teams.children.get(node.id)?.length" type="button" class="oc-branch" :class="{ open: expanded.has(node.id) }"
            :aria-expanded="expanded.has(node.id)" :aria-label="`${t('adminUsers.structure.belowStructure')}: ${nameOf(node.id)}`"
            @click="toggle(node.id)"
          ><span>{{ t('adminUsers.structure.belowStructure') }} · {{ teams.children.get(node.id)?.length }}</span><AppIcon name="chevron-down" :size="14" /></button>
        </article>
      </div>
    </div>
    <p v-if="!teams.roots.length" class="oc-empty">{{ t(forest.nodes.size ? 'adminUsers.structure.noManagers' : 'common.noData') }}</p>
    <section v-if="teams.unassigned.length" class="oc-unassigned">
      <OrgTeamList
        :members="teams.unassigned" :page="teamPages.unassigned ?? -1" :selected-id="selected"
        :group-name="t('adminUsers.structure.unassignedStaff')" :label="t('adminUsers.structure.unassignedStaff')"
        @select="select" @update:page="setTeamPage('unassigned', $event)"
      />
    </section>
    <section v-if="person" class="oc-details" aria-live="polite" :aria-label="t('adminUsers.structure.details')">
      <div class="oc-detail-heading"><h3>{{ nameOf(person.id) }}</h3><button type="button" class="oc-button" @click="selected = null; persist()">{{ t('common.close') }}</button></div>
      <dl>
        <div><dt>{{ t('adminUsers.structure.position') }}</dt><dd>{{ person.user.position || '—' }}</dd></div>
        <div><dt>{{ t('adminUsers.structure.column.manager') }}</dt><dd>{{ person.user.manager_id != null && !forest.nodes.has(person.user.manager_id) ? t('adminUsers.structure.managerUnavailable', { id: person.user.manager_id }) : person.user.manager_id == null ? t('adminUsers.structure.noManager') : nameOf(person.user.manager_id) }}</dd></div>
        <div><dt>{{ t('adminUsers.structure.directReports') }}</dt><dd>{{ person.children.length }}</dd></div>
        <div><dt>{{ t('adminUsers.structure.allReports') }}</dt><dd>{{ person.descendants }}</dd></div>
        <div><dt>{{ t('adminUsers.profile.field.login') }}</dt><dd>{{ person.user.username || '—' }}</dd></div>
        <div><dt>{{ t('adminUsers.profile.field.preset') }}</dt><dd>{{ person.user.preset ? presetLabelFromCatalog(person.user.preset, presets) : '—' }}</dd></div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.oc { min-width: 0; background: var(--ui-surface); border-radius: var(--ui-radius-md); box-shadow: var(--ui-shadow-sm); overflow: hidden; }
.oc-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--ui-border); }
.oc-hint { font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-muted); }
.oc-button { font: inherit; font-size: calc(var(--ui-font-scale, 1) * 13px); padding: 8px 12px; border: 1px solid var(--ui-border-strong); border-radius: var(--ui-radius-sm); background: var(--ui-surface); color: var(--ui-text); cursor: pointer; }
.oc-button:hover { background: var(--ui-surface-3); }
.oc-viewport { position: relative; height: 520px; max-height: 65vh; min-height: 280px; overflow: auto; overscroll-behavior-x: contain; overflow-anchor: none; }
.oc-canvas { position: relative; min-width: 100%; }
.oc-links { position: sticky; top: 0; left: 0; display: block; pointer-events: none; overflow: hidden; }
.oc-links path { fill: none; stroke: var(--ui-border-strong); stroke-width: 1.5; }
.oc-node { position: absolute; box-sizing: border-box; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); background: var(--ui-surface); box-shadow: var(--ui-shadow-sm); display: flex; flex-direction: column; overflow: hidden; }
.oc-node.selected { border-color: var(--ui-accent); }
.oc-node.selected .oc-person { background: var(--ui-accent-soft); }
.oc-person { display: flex; align-items: center; gap: 10px; height: 84px; box-sizing: border-box; flex-shrink: 0; width: 100%; border: 0; background: transparent; color: var(--ui-text); padding: 10px 14px; text-align: left; cursor: pointer; font: inherit; }
.oc-avatar { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; border-radius: 50%; color: var(--ui-accent); background: var(--ui-accent-soft); font-size: calc(var(--ui-font-scale, 1) * 12px); font-weight: 600; }
.oc-person-text { min-width: 0; }
.oc-name { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-size: calc(var(--ui-font-scale, 1) * 13px); line-height: 1.35; font-weight: 600; overflow-wrap: anywhere; }
.oc-position { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: calc(var(--ui-font-scale, 1) * 12px); color: var(--ui-text-muted); margin-top: 4px; line-height: 1.25; }
.oc-branch { display: flex; align-items: center; justify-content: space-between; gap: 8px; height: 40px; box-sizing: border-box; flex-shrink: 0; width: 100%; padding: 0 14px; border: 0; border-top: 1px solid var(--ui-border); background: var(--ui-surface-2); color: var(--ui-accent); font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); cursor: pointer; text-align: left; border-radius: 0 0 var(--ui-radius-md) var(--ui-radius-md); }
.oc-branch.open :deep(svg) { transform: rotate(180deg); }
.oc-toolbar-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.oc-button:disabled { opacity: .5; cursor: default; }
.oc-unassigned { margin: 16px; max-width: 440px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); padding-bottom: 4px; }
.oc-warning { padding: 12px 18px; margin: 0; color: var(--ui-warning); font-size: calc(var(--ui-font-scale, 1) * 13px); }
.oc-details { padding: 20px; border-top: 1px solid var(--ui-border); }
.oc-detail-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.oc-detail-heading h3 { margin: 0; color: var(--ui-text); font-size: calc(var(--ui-font-scale, 1) * 16px); overflow-wrap: anywhere; }
.oc-details dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 18px; margin: 18px 0 0; font-size: calc(var(--ui-font-scale, 1) * 13px); }
.oc-details dt { color: var(--ui-text-muted); margin-bottom: 5px; }
.oc-details dd { margin: 0; color: var(--ui-text); overflow-wrap: anywhere; }
.oc-empty { padding: 35px; text-align: center; color: var(--ui-text-muted); }
</style>
