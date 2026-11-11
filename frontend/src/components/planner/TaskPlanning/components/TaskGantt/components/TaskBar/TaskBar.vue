<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import LabeledBar from '../../../../../Bar/Bar.vue'
import { BarTooltip } from '@/components/common'
import { useDragPreview } from '@/composables/useDragPreview'
import { fmtDateTime } from '@/i18n/date'
import { t } from '@/i18n'
import { viewSettings } from '@/settings'
import { resourceBadgeRows } from '@/utils/resourceAccess'
import type { Task } from './types'
import type { TimelineCtx } from '@/composables/timeline-context'
import type { DtoCommentResponse, DtoUserInfo } from '@/api'

const props = withDefaults(
  defineProps<{
    timeline: TimelineCtx
    task: Task
    resourceBadgeIds?: ReadonlySet<number>
    projectCode?: string
    /** Custom task color (#RRGGBB); empty — the standard token */
    color?: string
    draggable?: boolean
    /** Vertical row reorder: pressing the bar body and dragging vertically calls
     *  this with the pointerdown event (horizontal drags keep changing dates). */
    startRowReorder?: ((e: PointerEvent) => void) | null
    /** Process bounds — limit task dragging */
    groupStartDate?: string | Date | number | null
    groupEndDate?: string | Date | number | null
    /** User directory — author names for comments in the tooltip */
    users?: DtoUserInfo[] | null
    /** Per-task comments cache (for the log in the tooltip) */
    commentsByTask?: Record<number, DtoCommentResponse[]> | null
  }>(),
  {
    projectCode: '',
    color: '',
    draggable: true,
    groupStartDate: null,
    groupEndDate: null,
    users: null,
    commentsByTask: null,
  },
)

const emit = defineEmits<{
  change: [payload: { start_date: string; end_date: string }]
  contextmenu: [payload: { clientX: number; clientY: number }]
  /** Single click on the bar (without dragging) — open the task editor */
  'edit': [payload: number]
  /** Tooltip opened on a task with comments — lazy-load them (cache) */
  'request-comments': [payload: number]
  /** Click on the comments badge (bubble + counter) - open the comments panel */
  'open-comments': [payload: number]
  /** Arrow-key move on the focused bar: proposed dates (live loading preview) */
  'keyboardmove': [payload: { start_date: string; end_date: string }]
}>()

/** Tooltip rows: owner + responsible (if assigned) + execution status + progress + date range */
const tooltipRows = (dateRange: string): string[] =>
  [taskOwnerLabel.value, taskResponsibleLabel.value, statusLabel.value, progressLabel.value, dateRange].filter(Boolean)

const taskOwnerLabel = computed<string>(() =>
  props.task.owner_name ? t('planner.taskBar.owner', { owner: props.task.owner_name }) : '',
)

const taskResponsibleLabel = computed<string>(() =>
  props.task.responsible_name ? t('planner.taskBar.responsible', { name: props.task.responsible_name }) : '',
)

/** Execution status label + color (fixed catalog, mirrors the badge stripe) */
const statusInfo = computed<{ label: string; color: string }>(() => {
  switch (props.task.status) {
    case 'done':
      return { label: t('planner.taskStatus.done'), color: '#22c55e' }
    case 'in_progress':
      return { label: t('planner.taskStatus.inProgress'), color: '#0f83c4' }
    default:
      return { label: t('planner.taskStatus.notStarted'), color: '#94a3b8' }
  }
})
const statusLabel = computed<string>(() =>
  props.task.status ? t('planner.taskBar.status', { status: statusInfo.value.label }) : '',
)

/**
 * Completion of the task's operations: done / total * 100 (equal weight).
 * null — the task has no operations (no badge).
 */
const taskProgress = computed<number | null>(() => {
  const subs = props.task.subtasks ?? []
  if (!subs.length) return null
  const done = subs.filter((s) => s.status === 'done').length
  return Math.round((done / subs.length) * 100)
})
const progressLabel = computed<string>(() =>
  taskProgress.value == null
    ? ''
    : t('planner.taskBar.progress', {
        value: taskProgress.value,
        done: props.task.subtasks?.filter((s) => s.status === 'done').length ?? 0,
        total: props.task.subtasks?.length ?? 0,
      }),
)

/** The task has comments — show a badge and the log in the tooltip */
const hasComments = computed(() => (props.task.comments_count ?? 0) > 0)

/** The badge itself is switchable (Settings → Diagram appearance); `hasComments`
 *  stays the fact that drives the tooltip's comment log either way. */
const showComments = computed(() => hasComments.value && viewSettings.badgeComments)

const userById = computed(() => new Map((props.users || []).map((u) => [u.id ?? 0, u])))

function fmtShortDate(iso?: string): string {
  if (!iso) return ''
  return fmtDateTime(iso)
}

/** Comment log for the tooltip: author name (from users), short date, text */
const tooltipComments = computed(() =>
  (props.commentsByTask?.[props.task.id] ?? []).map((c) => ({
    author:
      c.author_id != null
        ? userById.value.get(c.author_id)?.name ?? t('planner.taskBar.userFallback', { id: c.author_id })
        : undefined,
    date: fmtShortDate(c.created_at),
    text: c.content ?? '',
  })),
)

/** Tooltip opened: if the task has comments — lazy-load them (cache) */
function onTooltipOpen() {
  if (!hasComments.value) return
  emit('request-comments', props.task.id)
}

/** Live loading preview: publish the dragged task and its new dates */
const dragPreview = useDragPreview()

function setDragPreview(d: { start_date: string; end_date: string } | null) {
  if (!dragPreview) return
  if (!d) {
    dragPreview.value.active = false
    return
  }
  if (!props.task.resources?.length) return
  dragPreview.value = {
    active: true,
    taskId: props.task.id,
    startDate: d.start_date,
    endDate: d.end_date,
  }
}

/** Resource badge label: the code, or the full name if absent */
function badgeLabel(r: { code?: string; title?: string }): string {
  return r.code || r.title || '?'
}

const visibleResourceBadges = computed(() => resourceBadgeRows(props.task.resources, props.resourceBadgeIds))

// === Badges: project code, owner, progress + a stack of resource badges ===
// Enabled badges are ALWAYS rendered: the title is the only flexible element in
// the row (`flex: 0 1 auto` + ellipsis), so it yields the space and the badges
// never get dropped just because the text is long. The badges are rigid
// (`flex-shrink: 0`), so the only remaining question is whether the resource
// strip still fits next to them — when it does not, its chips overlap each
// other (hovering the bar shows a tooltip with all of them).
const contentRef = ref<HTMLElement | null>(null)
const badgesRef = ref<HTMLElement | null>(null)
const stacked = ref(false)

let resizeObserver: ResizeObserver | null = null

/** Natural width of the resource strip: chips + the 6px gap between them.
 *  Independent of the stacked state, so measuring never feeds back into it. */
function naturalStripWidth(badges: HTMLElement): number {
  const chips = Array.from(badges.children) as HTMLElement[]
  if (!chips.length) return 0
  const w = chips.reduce((sum, chip) => sum + chip.getBoundingClientRect().width, 0)
  return w + 6 * (chips.length - 1)
}

function updateStacked() {
  const content = contentRef.value
  const badges = badgesRef.value
  if (!content || !badges) return
  // Free room left for the strip in the current layout: everything to its left
  // (status stripe, the title as actually truncated, the badges before it) is
  // already placed, so the strip starts where it starts.
  const free = content.getBoundingClientRect().right - badges.getBoundingClientRect().left
  stacked.value = naturalStripWidth(badges) > free
}

onMounted(() => {
  updateStacked()
  resizeObserver = new ResizeObserver(updateStacked)
  if (contentRef.value) resizeObserver.observe(contentRef.value)
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
})

// After the resource set or the project code changes, recompute the layout
watch(
  () => visibleResourceBadges.value,
  () => requestAnimationFrame(updateStacked),
)
watch(
  () => props.task.subtasks,
  () => requestAnimationFrame(updateStacked),
)
watch(
  () => props.task.status,
  () => requestAnimationFrame(updateStacked),
)
watch(
  () => props.projectCode,
  () => requestAnimationFrame(updateStacked),
)
watch(
  () => [props.task.owner_short, props.task.owner_name, props.task.responsible_short, props.task.responsible_name],
  () => requestAnimationFrame(updateStacked),
)
// The title's own width moves the resource strip (the title is the flexible
// element), so a longer title has to re-evaluate the strip's room.
watch(
  () => props.task.title,
  () => requestAnimationFrame(updateStacked),
)
</script>

<template>
  <LabeledBar
    :timeline="timeline"
    :startDate="task.start_date"
    :endDate="task.end_date"
    :groupStartDate="groupStartDate"
    :groupEndDate="groupEndDate"
    :title="task.title"
    :color="color || task.color || 'var(--ui-gantt-task)'"
    :draggable="draggable"
    :start-row-reorder="startRowReorder"
    :aria-label="t('planner.bar.taskQuoted', { title: task.title })"
    @change="(d) => emit('change', d)"
    @contextmenu="(p) => emit('contextmenu', p)"
    @dragstart="(d) => setDragPreview(d)"
    @dragmove="(d) => setDragPreview(d)"
    @keyboardmove="(d) => setDragPreview(d)"
    @dragend="() => setDragPreview(null)"
    @click="emit('edit', task.id)"
    @tooltip-open="onTooltipOpen"
  >
    <span ref="contentRef" class="tb-content">
      <span
        v-if="task.status"
        class="tb-status"
        :style="{ background: statusInfo.color }"
        :title="statusInfo.label"
      ></span>
      <span class="tb-title">{{ task.title }}</span>
      <span
        v-if="viewSettings.badgeTaskProjectCode && projectCode"
        class="tb-proj"
      >{{ projectCode }}</span>
      <span
        v-if="viewSettings.badgeTaskOwner && task.owner_short"
        class="tb-owner"
        :title="task.owner_name"
      >{{ task.owner_short }}</span>
      <span
        v-if="viewSettings.badgeTaskResponsible && task.responsible_short"
        class="tb-responsible"
        :title="task.responsible_name"
      >{{ task.responsible_short }}</span>
      <span
        v-if="taskProgress != null && viewSettings.badgeProgress"
        class="tb-progress"
        :class="{ 'is-done': taskProgress === 100, 'is-empty': taskProgress === 0 }"
        :title="progressLabel"
      >{{ taskProgress }}%</span>
      <span
        v-if="viewSettings.badgeResource && visibleResourceBadges.length"
        ref="badgesRef"
        class="tb-badges"
        :class="{ 'is-stacked': stacked }"
      >
        <span
          v-for="r in visibleResourceBadges"
          :key="r.resource_id"
          class="tb-badge"
          :style="r.color ? { background: r.color } : undefined"
        >{{ badgeLabel(r) }}×{{ r.quantity }}</span>
      </span>
      <span v-if="showComments" class="tb-comments" :title="t('planner.taskBar.comments', { count: task.comments_count })" @pointerdown.stop @click.stop="emit('open-comments', task.id)">
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
        </svg>
        <span>{{ task.comments_count }}</span>
      </span>
    </span>
    <template #tooltip="{ dateRange }">
      <BarTooltip
        :title="task.title"
        :accent="color || task.color || 'var(--ui-gantt-task)'"
        :rows="tooltipRows(dateRange)"
        :resources="(task.resources || []).map((r) => ({ label: r.title || r.code, quantity: r.quantity, color: r.color }))"
        :comments="tooltipComments"
      />
    </template>
  </LabeledBar>
</template>

<style scoped>
@import "../../../../../../../styles/tokens.css";
.tb-content {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
}
.tb-title {
  flex: 0 1 auto;
  min-width: 0;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 700;
  color: var(--ui-accent-on);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
/* Execution status stripe (left edge of the bar) */
.tb-status {
  flex-shrink: 0;
  width: 5px;
  height: 100%;
  margin-right: 6px;
  border-radius: 3px 0 0 3px;
  pointer-events: none;
}
.tb-proj {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 600;
  line-height: 1.6;
  color: #fff;
  background: rgba(0, 0, 0, 0.22);
  border-radius: 10px;
  padding: 0 7px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
.tb-owner {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 600;
  line-height: 1.6;
  color: #fff;
  background: rgba(13, 102, 134, 0.85);
  border-radius: 10px;
  padding: 0 7px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
/* Responsible person badge — distinct tint from the owner chip */
.tb-responsible {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 600;
  line-height: 1.6;
  color: #fff;
  background: rgba(99, 76, 170, 0.85);
  border-radius: 10px;
  padding: 0 7px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
/* Completion percentage of the task's operations (badge on the bar) */
.tb-progress {
  flex-shrink: 0;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 700;
  line-height: 1.6;
  color: #fff;
  background: var(--ui-accent);
  border-radius: 10px;
  padding: 0 7px;
  margin-left: 6px;
  white-space: nowrap;
  pointer-events: none;
}
.tb-progress.is-done {
  background: #22c55e;
}
.tb-progress.is-empty {
  background: #94a3b8;
}
.tb-badges {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  /* The strip starts 6px after the previous badge, like every other badge in
     the row (its first chip has no left margin of its own). */
  margin-left: 6px;
  white-space: nowrap;
}
/* Badge — a plain flex item, sized exactly to the text; 6px gap between badges */
.tb-badge {
  flex-shrink: 0;
  width: fit-content;
  margin-left: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 700;
  line-height: 1.6;
  color: #fff;
  background: var(--ui-danger);
  border: 1px solid rgba(255, 255, 255, 0.55);
  border-radius: 10px;
  padding: 0 7px;
  white-space: nowrap;
  pointer-events: none;
}
/* Badges do not fit side by side — stack them: each next one
   overlaps the previous; hovering the bar shows a tooltip with all resources */
.tb-badges .tb-badge:first-child {
  margin-left: 0;
}
.tb-badges.is-stacked .tb-badge {
  margin-left: -7px;
}
.tb-badges.is-stacked .tb-badge:first-child {
  margin-left: 0;
}
/* Comments badge: dialog bubble + counter; a click opens the comments panel */
.tb-comments {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  margin-left: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 10px);
  font-weight: 700;
  line-height: 1.6;
  color: #fff;
  background: rgba(0, 0, 0, 0.22);
  border-radius: 10px;
  padding: 0 7px;
  white-space: nowrap;
  cursor: pointer;
}
/* Hover over the comments badge: highlight so it reads as clickable */
.tb-comments:hover {
  background: var(--ui-accent);
}
</style>
