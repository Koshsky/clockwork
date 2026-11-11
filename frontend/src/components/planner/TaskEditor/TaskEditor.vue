<script setup lang="ts">
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { ModalForm, ColorField, PendingMark, TooltipCell } from '../../common'
import { t } from '@/i18n'
import type {
  TaskEditorProps,
  NewSubtaskPayload,
  UpdateSubtaskPayload,
  TaskEditorPatch,
  TaskEditorSection,
} from './types'
import type { DependencyType } from '../dependencies'
import { dependencyLabel, DEPENDENCY_TYPES } from '../dependencies'

const props = withDefaults(defineProps<TaskEditorProps>(), {
  workspace: false,
  section: 'details',
  context: '',
  schedule: '',
  resourceCount: 0,
  commentCount: 0,
  hasRelatedDrafts: false,
  task: null,
  canManage: false,
  canCreateSubtask: false,
  canManageDependencies: false,
  busy: false,
  error: null,
  disabledReason: null,
  dependencies: () => [],
  dependencyOptions: () => [],
})

const emit = defineEmits<{
  save: [patch: TaskEditorPatch, acknowledge?: (saved: boolean) => void]
  'update:section': [section: TaskEditorSection]
  addSubtask: [payload: NewSubtaskPayload]
  updateSubtask: [payload: UpdateSubtaskPayload]
  deleteSubtask: [id: number]
  addDependency: [payload: { depends_on_task_id: number; type: DependencyType }]
  updateDependency: [payload: { id: number; type: DependencyType }]
  deleteDependency: [id: number]
  close: []
}>()

// === Left panel: task fields ===
const title = ref('')
const color = ref('')
const status = ref('')
const ownerId = ref<number | ''>('')
const responsibleId = ref<number | ''>('')
const newTitle = ref('')
const newDepTaskId = ref<number | ''>('')
const newDepType = ref<DependencyType>('fs')

// Status catalog (fixed 3-set, mirrors the backend CHECK). Computed so the
// labels re-render after a language switch.
const statusOptions = computed(() => [
  { value: 'not_started', label: t('planner.taskStatus.notStarted') },
  { value: 'in_progress', label: t('planner.taskStatus.inProgress') },
  { value: 'done', label: t('planner.taskStatus.done') },
])

const baseline = ref('')
const saving = ref(false)
const saveFailed = ref(false)
const confirmClose = ref(false)
const closeAfterSave = ref(false)
const confirmationEl = ref<HTMLElement | null>(null)
let returnFocus: HTMLElement | null = null
function draftSnapshot() {
  return JSON.stringify([title.value, color.value, status.value, ownerId.value, responsibleId.value])
}
const dirty = computed(() => draftSnapshot() !== baseline.value)
const hasDrafts = computed(() => dirty.value || props.hasRelatedDrafts || !!newTitle.value.trim() || newDepTaskId.value !== '')
const sections = computed(() => [
  { id: 'details' as const, label: t('planner.workspace.details') },
  { id: 'subtasks' as const, label: t('planner.workspace.subtasks'), count: props.subtasks.length },
  { id: 'dependencies' as const, label: t('planner.taskEditor.dependenciesTitle'), count: props.dependencies.length },
  { id: 'resources' as const, label: t('planner.workspace.resources'), count: props.resourceCount },
  { id: 'discussion' as const, label: t('planner.workspace.discussion'), count: props.commentCount },
])

watch(
  [() => props.open, () => props.task?.id],
  ([open]) => {
    if (!open || !props.task) return
    title.value = props.task.title ?? ''
    color.value = props.task.color ?? ''
    status.value = props.task.status ?? 'not_started'
    ownerId.value = props.task.owner_id ?? ''
    responsibleId.value = props.task.responsible_id ?? ''
    baseline.value = draftSnapshot()
    confirmClose.value = false
    saving.value = false
    closeAfterSave.value = false
    saveFailed.value = false
    newTitle.value = ''
    newDepTaskId.value = ''
    newDepType.value = 'fs'
  },
  { immediate: true },
)

function requestClose() {
  if (props.busy || saving.value) return
  if (!props.workspace || !hasDrafts.value) {
    emit('close')
    return
  }
  if (confirmClose.value) {
    continueEditing()
    return
  }
  returnFocus = document.activeElement as HTMLElement | null
  confirmClose.value = true
  void nextTick(() => confirmationEl.value?.focus())
}

function continueEditing() {
  confirmClose.value = false
  void nextTick(() => returnFocus?.isConnected && returnFocus.focus({ preventScroll: true }))
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!props.open || !props.workspace || !hasDrafts.value) return
  event.preventDefault()
  event.returnValue = ''
}
if (typeof window !== 'undefined') window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload))

const canSave = computed(() => props.canManage && !props.busy && !saving.value && title.value.trim() !== '')

function onSave() {
  if (!canSave.value) return
  const owner =
    ownerId.value === '' ? null : Number(ownerId.value)
  // Owner cannot be removed: null means "not sent" (the backend keeps the old).
  const patch: { title?: string; color?: string; status?: string; owner_id?: number; responsible_id?: number } = {
    title: title.value.trim(),
    color: color.value || undefined,
    status: status.value,
  }
  if (owner != null) patch.owner_id = owner
  // 0 is the "clear responsible" sentinel (no responsible person).
  patch.responsible_id = responsibleId.value === '' ? 0 : Number(responsibleId.value)
  if (!props.workspace) {
    emit('save', patch)
    return
  }
  const snapshot = draftSnapshot()
  const taskId = props.task?.id
  saving.value = true
  saveFailed.value = false
  emit('save', patch, (saved) => {
    if (props.task?.id !== taskId) return
    saving.value = false
    saveFailed.value = !saved
    if (saved) {
      baseline.value = snapshot
      if (closeAfterSave.value) emit('close')
    }
    closeAfterSave.value = false
  })
}

// === Right panel: subtasks (todo list) ===

const canAdd = computed(
  () => props.canCreateSubtask && !props.busy && newTitle.value.trim() !== '',
)

function onAddSubtask() {
  if (!canAdd.value) return
  emit('addSubtask', { title: newTitle.value.trim() })
  newTitle.value = ''
}

/** Status label for a subtask row (short) */
function subtaskStatusLabel(s: { status?: string }): string {
  switch (s.status) {
    case 'done':
      return t('planner.taskStatus.done')
    case 'in_progress':
      return t('planner.taskStatus.inProgress')
    default:
      return t('planner.taskStatus.notStarted')
  }
}

/** Cycle a subtask status: not_started → in_progress → done → not_started */
function cycleStatus(s: { id: number; status?: string }) {
  if (props.busy || !(props.canUpdateSubtask?.(s.id) ?? props.canManage)) return
  const next =
    s.status === 'not_started'
      ? 'in_progress'
      : s.status === 'in_progress'
        ? 'done'
        : 'not_started'
  emit('updateSubtask', { id: s.id, patch: { status: next } })
}

function onDeleteSubtask(id: number) {
  if (props.busy || !(props.canDeleteSubtask?.(id) ?? props.canManage)) return
  emit('deleteSubtask', id)
}

// === Dependencies panel (predecessor links) ===

/** Type options with the localized labels (Finish → Start, ...). Computed
 *  so the option labels re-render after a language switch. */
const depTypeOptions = computed(() =>
  DEPENDENCY_TYPES.map((type) => ({ value: type, label: dependencyLabel(type) })),
)

const canAddDependency = computed(
  () =>
    props.canManageDependencies &&
    !props.busy &&
    newDepTaskId.value !== '' &&
    props.dependencyOptions.some((o) => o.value === newDepTaskId.value),
)

function onAddDependency() {
  if (!canAddDependency.value || newDepTaskId.value === '') return
  emit('addDependency', { depends_on_task_id: newDepTaskId.value, type: newDepType.value })
  newDepTaskId.value = ''
  newDepType.value = 'fs'
}

function onDepTypeChange(dep: { id: number; type: DependencyType }, type: DependencyType) {
  if (props.busy || !props.canManageDependencies || dep.type === type) return
  emit('updateDependency', { id: dep.id, type })
}

function onDeleteDependency(id: number) {
  if (props.busy || !props.canManageDependencies) return
  emit('deleteDependency', id)
}
</script>

<template>
  <ModalForm
    :open="open"
    :title="task ? t('planner.taskEditor.titleNamed', { title: task.title }) : t('planner.taskEditor.title')"
    :max-width="workspace ? '1180px' : '960px'"
    :dialog-class="workspace ? 'te-workspace' : undefined"
    :close-disabled="workspace && (busy || saving)"
    @close="requestClose"
  >
    <div v-if="workspace" class="te-context">
      <span v-if="context">{{ context }}</span>
      <span v-if="schedule">{{ schedule }}</span>
    </div>
    <div v-if="confirmClose" ref="confirmationEl" class="te-confirm" tabindex="-1">
      <h4>{{ t('planner.workspace.unsavedTitle') }}</h4>
      <p>{{ t('planner.workspace.unsavedBody') }}</p>
      <div class="te-confirm-actions">
        <button type="button" class="te-cancel" @click="continueEditing">{{ t('planner.workspace.continueEditing') }}</button>
        <button type="button" class="te-cancel te-discard" @click="emit('close')">{{ t('planner.workspace.discard') }}</button>
        <button v-if="dirty && !hasRelatedDrafts && !newTitle.trim() && newDepTaskId === ''" type="button" class="te-save" :disabled="!canSave" @click="closeAfterSave = true; onSave()">{{ t('planner.workspace.saveAndClose') }}</button>
      </div>
    </div>
    <div v-show="!confirmClose" class="te-body" :class="{ 'te-workspace-body': workspace }">
      <nav v-if="workspace" class="te-nav" :aria-label="t('planner.workspace.sections')">
        <button v-for="item in sections" :key="item.id" type="button" :class="{ 'is-active': section === item.id }" :aria-current="section === item.id ? 'page' : undefined" :aria-controls="`task-${task?.id}-${item.id}`" @click="emit('update:section', item.id)">
          <span>{{ item.label }}</span><span v-if="item.count != null" class="te-count">{{ item.count }}</span>
        </button>
      </nav>
      <div class="te-content">
      <div v-show="!workspace || section === 'details'" :id="`task-${task?.id}-details`" class="te-left">
        <h4 v-if="workspace" class="te-section-title">{{ t('planner.workspace.details') }}</h4>
        <label class="te-field">
          <span class="te-label">{{ t('planner.taskEditor.field.name') }}</span>
          <input
            v-model="title"
            class="te-input"
            type="text"
            :disabled="!canManage || busy || saving"
            :placeholder="task?.title || t('planner.taskEditor.field.namePlaceholder')"
          />
        </label>

        <div class="te-field">
          <span class="te-label">{{ t('planner.taskEditor.field.status') }}</span>
          <select
            v-model="status"
            :aria-label="t('planner.taskEditor.field.status')"
            class="te-input te-select"
            :disabled="!canManage || busy || saving"
          >
            <option v-for="o in statusOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </div>

        <div class="te-field">
          <span class="te-label">{{ t('planner.taskEditor.field.owner') }}</span>
          <select
            v-model="ownerId"
            :aria-label="t('planner.taskEditor.field.owner')"
            class="te-input te-select"
            :disabled="!canManage || busy || saving"
          >
            <option value="">{{ t('planner.taskEditor.field.ownerNone') }}</option>
            <option v-for="o in ownerOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </div>

        <div class="te-field">
          <span class="te-label">{{ t('planner.taskEditor.field.responsible') }}</span>
          <select
            v-model="responsibleId"
            :aria-label="t('planner.taskEditor.field.responsible')"
            class="te-input te-select"
            :disabled="!canManage || busy || saving"
          >
            <option value="">{{ t('planner.taskEditor.field.responsibleNone') }}</option>
            <option v-for="o in ownerOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
        </div>

        <div class="te-field">
          <span class="te-label">{{ t('planner.taskEditor.field.color') }}</span>
          <ColorField v-model="color" :disabled="!canManage || busy || saving" :label="t('planner.taskEditor.field.colorLabel')" />
        </div>

        <p v-if="!canManage && !disabledReason" class="te-note">
          {{ t('planner.taskEditor.readonly') }}
        </p>

        <div v-if="!workspace" class="te-actions">
          <button
            type="button"
            class="te-cancel"
            @click="requestClose"
          >
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="te-save"
            :disabled="!canSave"
            @click="onSave"
          >
            <span v-if="busy" class="te-spinner" />
            {{ t('common.save') }}
          </button>
        </div>
      </div>

      <div class="te-right">
        <section v-show="!workspace || section === 'subtasks'" :id="`task-${task?.id}-subtasks`" class="te-section">
        <h4 class="te-subtitle">{{ t(workspace ? 'planner.workspace.subtasks' : 'planner.taskEditor.subtasksTitle') }}</h4>
        <p v-if="error" class="te-error">{{ error }}</p>

        <div v-if="subtasks.length" class="te-list">
          <div v-for="s in subtasks" :key="s.id" class="te-item">
            <TooltipCell :text="t('planner.taskEditor.subtaskStatusHint', { status: subtaskStatusLabel(s) })" multiline>
              <button
                type="button"
                class="te-status"
                :class="`is-${s.status || 'not_started'}`"
                :title="t('planner.taskEditor.subtaskStatusHint', { status: subtaskStatusLabel(s) })"
                :disabled="!(canUpdateSubtask?.(s.id) ?? canManage) || busy"
                @click="cycleStatus(s)"
              />
            </TooltipCell>
            <span class="te-item-title" :title="s.title">{{ s.title }}</span>
            <PendingMark entity="task" :id="s.id" />
            <button
              type="button"
              class="te-remove"
              :disabled="!(canDeleteSubtask?.(s.id) ?? canManage) || busy"
              :aria-label="t('planner.taskEditor.subtask.deleteAria', { title: s.title })"
              @click="onDeleteSubtask(s.id)"
            >✕</button>
          </div>
        </div>
        <div v-else class="te-empty">{{ t('planner.taskEditor.subtask.empty') }}</div>

        <div class="te-add">
          <input
            v-model="newTitle"
            class="te-input"
            type="text"
            :placeholder="t('planner.taskEditor.subtask.newPlaceholder')"
            :disabled="!canCreateSubtask || busy"
            @keyup.enter="onAddSubtask"
          />
          <button
            type="button"
            class="te-add-btn"
            :disabled="!canAdd"
            @click="onAddSubtask"
          >
            {{ t('common.add') }}
          </button>
        </div>
        <p v-if="disabledReason" class="te-note">{{ disabledReason }}</p>

        </section>
        <section v-show="!workspace || section === 'dependencies'" :id="`task-${task?.id}-dependencies`" class="te-section">
        <h4 class="te-subtitle">{{ t('planner.taskEditor.dependenciesTitle') }}</h4>

        <div v-if="dependencies.length" class="te-list">
          <div v-for="d in dependencies" :key="d.id" class="te-item">
            <span class="te-item-title" :title="d.title">{{ d.title }}</span>
            <select
              class="te-input te-select te-dep-type"
              :value="d.type"
              :disabled="!canManageDependencies || busy"
              :aria-label="t('planner.taskEditor.dependency.typeAria', { title: d.title })"
              @change="onDepTypeChange(d, ($event.target as HTMLSelectElement).value as DependencyType)"
            >
              <option v-for="o in depTypeOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
            <button
              type="button"
              class="te-remove"
              :disabled="!canManageDependencies || busy"
              :aria-label="t('planner.taskEditor.dependency.deleteAria', { title: d.title })"
              @click="onDeleteDependency(d.id)"
            >✕</button>
          </div>
        </div>
        <div v-else class="te-empty">{{ t('planner.taskEditor.dependency.empty') }}</div>

        <div class="te-dep-add">
          <select
            v-model="newDepTaskId"
            class="te-input te-select"
            :disabled="!canManageDependencies || busy"
            :aria-label="t('planner.taskEditor.dependency.predecessorAria')"
          >
            <option value="">{{ t('planner.taskEditor.dependency.predecessorNone') }}</option>
            <option v-for="o in dependencyOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <select
            v-model="newDepType"
            class="te-input te-select te-dep-type"
            :disabled="!canManageDependencies || busy"
            :aria-label="t('planner.taskEditor.dependency.typeAriaShort')"
          >
            <option v-for="o in depTypeOptions" :key="o.value" :value="o.value">
              {{ o.label }}
            </option>
          </select>
          <button
            type="button"
            class="te-add-btn"
            :disabled="!canAddDependency"
            @click="onAddDependency"
          >
            {{ t('common.add') }}
          </button>
        </div>
        <p class="te-note">{{ t('planner.taskEditor.dependencyNote') }}</p>
        </section>
      </div>
      <section v-if="workspace" v-show="section === 'resources'" :id="`task-${task?.id}-resources`" class="te-section te-slot">
        <h4 class="te-section-title">{{ t('planner.workspace.resources') }}</h4>
        <slot name="resources" />
      </section>
      <section v-if="workspace" v-show="section === 'discussion'" :id="`task-${task?.id}-discussion`" class="te-section te-slot te-discussion">
        <h4 class="te-section-title">{{ t('planner.workspace.discussion') }}</h4>
        <slot name="discussion" />
      </section>
      </div>
    </div>
    <div v-if="workspace" class="te-footer">
      <p v-if="error || saveFailed" class="te-error" role="alert">{{ error || t('planner.workspace.saveFailed') }}</p>
      <span v-else-if="dirty" class="te-note">{{ t('planner.workspace.unsaved') }}</span>
      <span v-else class="te-note">{{ t('planner.workspace.independentActions') }}</span>
      <div v-if="!confirmClose" class="te-actions">
        <button type="button" class="te-cancel" :disabled="busy || saving" @click="requestClose">{{ t('common.close') }}</button>
        <button v-if="canManage" type="button" class="te-save" :disabled="!canSave || !dirty" @click="onSave">
          <span v-if="saving" class="te-spinner" />{{ t('planner.workspace.saveTask') }}
        </button>
      </div>
    </div>
  </ModalForm>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.te-body {
  display: grid;
  grid-template-columns: minmax(0, 320px) minmax(0, 1fr);
  gap: 24px;
  padding: 16px;
}
.te-content { display: contents; }
.te-section { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.te-left,
.te-right {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.te-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.te-label {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-2);
  font-weight: 500;
}
.te-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 9px 12px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
  transition: border-color var(--ui-duration), box-shadow var(--ui-duration);
}
.te-input:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.te-input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.te-select {
  height: 40px;
}
.te-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.te-cancel {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-surface-2);
  color: var(--ui-text-2);
}
.te-cancel:hover {
  background: var(--ui-border);
  color: var(--ui-text);
}
.te-save {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  align-self: flex-start;
}
.te-save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.te-save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.te-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.4);
  border-top-color: var(--ui-accent-on);
  border-radius: 50%;
  animation: te-spin 0.7s linear infinite;
}
@keyframes te-spin {
  to {
    transform: rotate(360deg);
  }
}
.te-subtitle {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 700;
  color: var(--ui-text);
}
.te-error {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}
.te-note {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
}
.te-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.te-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 9px;
  background: var(--ui-surface-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  color: var(--ui-text);
}
.te-status {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border: none;
  border-radius: 50%;
  padding: 0;
  cursor: pointer;
  transition: transform var(--ui-duration);
}
.te-status:hover:not(:disabled) {
  transform: scale(1.2);
}
.te-status:disabled {
  cursor: not-allowed;
}
.te-status.is-not_started {
  background: #94a3b8;
}
.te-status.is-in_progress {
  background: #0f83c4;
}
.te-status.is-done {
  background: #22c55e;
}
.te-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.te-remove {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.te-remove:hover:not(:disabled) {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}
.te-remove:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
.te-empty {
  padding: 14px 0;
  text-align: center;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-muted);
  border: 1px dashed var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
}
.te-add {
  display: flex;
  gap: 8px;
}
.te-add .te-input {
  flex: 1;
}
.te-add-btn {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  white-space: nowrap;
}
.te-add-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.te-add-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

/* Dependency panel: a compact type select inside the row + the add row */
.te-dep-type {
  flex-shrink: 0;
  width: auto;
  max-width: 170px;
  height: 30px;
  padding: 3px 8px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}
.te-dep-add {
  display: flex;
  gap: 8px;
}
.te-dep-add .te-select {
  flex: 1;
  min-width: 0;
}

@media (max-width: 640px) {
  .te-body {
    grid-template-columns: 1fr;
  }
}
</style>
<style scoped>
:global(.te-workspace .mf-title) { min-width: 0; overflow-wrap: anywhere; }
:global(.te-workspace .mf-close) { flex-shrink: 0; }
:global(.te-workspace) { display: flex; flex-direction: column; max-height: calc(100dvh - 32px); }
.te-context { flex-shrink: 0; display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding: 10px 20px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 12px); border-bottom: 1px solid var(--ui-border); }
.te-context:empty { display: none; }
.te-context span { min-width: 0; overflow-wrap: anywhere; }
.te-workspace-body { grid-template-columns: 184px minmax(0, 1fr); gap: 0; padding: 0; height: min(620px, calc(100dvh - 230px)); min-height: 180px; overflow: hidden; }
.te-nav { padding: 16px 10px; display: flex; flex-direction: column; gap: 5px; background: var(--ui-surface-2); border-right: 1px solid var(--ui-border); overflow-y: auto; }
.te-nav button { display: flex; align-items: center; justify-content: space-between; gap: 8px; border: 0; border-radius: var(--ui-radius-sm); padding: 11px 12px; background: transparent; color: var(--ui-text-2); font: inherit; font-size: calc(var(--ui-font-scale, 1) * 13px); cursor: pointer; text-align: left; }
.te-nav button:hover { background: var(--ui-border); }
.te-nav button.is-active { background: var(--ui-surface); color: var(--ui-accent); box-shadow: var(--ui-shadow-sm); font-weight: 600; }
.te-count { font-size: calc(var(--ui-font-scale, 1) * 11px); color: var(--ui-text-muted); font-variant-numeric: tabular-nums; }
.te-workspace-body .te-content { display: block; min-width: 0; overflow-y: auto; padding: 24px; }
.te-workspace-body .te-right { display: contents; }
.te-workspace-body .te-left { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; }
.te-workspace-body .te-left > :first-child, .te-workspace-body .te-left > label, .te-workspace-body .te-note { grid-column: 1 / -1; }
.te-section-title { margin: 0 0 4px; color: var(--ui-text); font-size: calc(var(--ui-font-scale, 1) * 16px); }
.te-slot :deep(.rm-body), .te-slot :deep(.tc) { padding: 0; }
.te-discussion { height: 100%; min-height: 0; }
.te-discussion > :deep(div) { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.te-discussion :deep(.tc) { flex: 1; min-height: 0; }
.te-discussion :deep(.tc-list) { flex: 1; min-height: 0; max-height: none; overflow-y: auto; }
.te-discussion :deep(.tc-composer) { flex-shrink: 0; }
.te-discussion :deep(.tc-composer textarea) { max-height: 180px; }
.te-slot :deep(.rm-btn) { align-self: flex-start; }
.te-footer { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; border-top: 1px solid var(--ui-border); padding: 14px 20px; }
.te-footer .te-actions { margin-left: auto; flex-wrap: wrap; justify-content: flex-end; max-width: 100%; }
.te-confirm { padding: 32px 24px; color: var(--ui-text); outline: none; }
.te-confirm h4 { margin: 0 0 12px; }
.te-confirm p { color: var(--ui-text-2); line-height: 1.5; }
.te-confirm-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 24px; }
.te-discard { color: var(--ui-danger); }
@media (max-width: 640px) {
  .te-workspace-body { display: flex; flex-direction: column; height: calc(100dvh - 220px); }
  .te-nav { flex-shrink: 0; flex-direction: row; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--ui-border); padding: 8px; }
  .te-nav button { white-space: nowrap; padding: 9px; }
  .te-workspace-body .te-content { padding: 16px; }
  .te-workspace-body .te-left { grid-template-columns: 1fr; gap: 14px; }
  .te-footer { padding: 12px; }
  .te-footer > .te-note { display: none; }
  .te-context { padding: 8px 16px; gap: 4px; }
  .te-workspace-body .te-dep-add { flex-wrap: wrap; }
}
</style>
