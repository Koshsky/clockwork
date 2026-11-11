<script setup lang="ts">
import { HintButton } from '../components/common'
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useAppStore, useRbacStore } from '../store'
import { isWorkerPreset } from '../rbac/presets'
import { ColorField, ConfirmDialog } from '../components/common'
import { randomPaletteColor } from '../components/common/ColorField/palette'
import { useConfirm } from '../composables/useConfirm'
import { notifyError, notifySuccess } from '../notify/state'
import { t } from '@/i18n'

interface LocalResource {
  resource_id: number
  quantity: number
}
interface LocalOperation {
  title: string
}
interface LocalTask {
  title: string
  color: string
  resources: LocalResource[]
  operations: LocalOperation[]
}
interface LocalProcess {
  title: string
  owner_id: number | null
  color: string
  tasks: LocalTask[]
}

/** Template limits — mirrored from the backend (auto_create service) so the
 *  user gets the error before the PUT, with the same wording. */
const LIMITS = {
  maxProcesses: 20,
  maxTasksPerProcess: 50,
  maxOperationsPerTask: 50,
  maxResourcesPerTask: 10,
  maxAssignmentsTotal: 500,
  maxQuantity: 99,
} as const

/**
 * Neutral "background" color of auto-created tasks — the two-type color scheme:
 * accent (vivid) marks a few important tasks, neutral (this shared constant)
 * is the calm backdrop for the rest. The type is encoded in the task color
 * value; the constant must match the seed migration
 * (migrations/plugins/V905__auto_create_two_type_colors.sql).
 */
const NEUTRAL_TASK_COLOR = '#94A3B8'

/** Task color type: accent (a vivid custom color) vs neutral (the shared background tone) */
function isAccentTask(color: string): boolean {
  return color !== '' && color !== NEUTRAL_TASK_COLOR
}

/** Switches a task's color type; switching to accent picks a random vivid color */
function setTaskType(t: LocalTask, type: 'accent' | 'neutral') {
  if (type === 'neutral') {
    t.color = NEUTRAL_TASK_COLOR
  } else if (!isAccentTask(t.color)) {
    t.color = randomPaletteColor()
  }
  dirty.value = true
}

const app = useAppStore()
const rbac = useRbacStore()
const canConfigure = computed(() => rbac.can('auto_create', 'update'))
const { autoCreateConfig, autoCreateLoading, autoCreateError, users, resources } = storeToRefs(app)

const form = reactive<{ enabled: boolean; processes: LocalProcess[] }>({ enabled: true, processes: [] })
const dirty = ref(false)
const saving = ref(false)
const previewOpen = ref(false)

const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()

/** Process owner candidates (excluding workers) */
const ownerOptions = computed(() =>
  users.value
    .filter((u) => !isWorkerPreset(u.preset))
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '', 'ru'))
    .map((u) => ({ value: u.id as number, label: u.name ?? `#${u.id}` })),
)

/** Task resource candidates */
const resourceOptions = computed(() =>
  [...resources.value]
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '', 'ru'))
    .map((r) => ({ value: r.id as number, label: `${r.title}${r.code ? ` (${r.code})` : ''}` })),
)

function resourceLabel(id?: number): string {
  const r = resources.value.find((x) => x.id === id)
  return r ? `${r.title}${r.code ? ` (${r.code})` : ''}` : '—'
}

/** Live summary of what a new project would get from the current template */
const preview = computed(() => {
  let tasks = 0
  let operations = 0
  let assignments = 0
  for (const p of form.processes) {
    tasks += p.tasks.length
    for (const t of p.tasks) {
      operations += t.operations.length
      assignments += t.resources.length
    }
  }
  return { processes: form.processes.length, tasks, operations, assignments }
})

function resetForm() {
  const cfg = autoCreateConfig.value
  form.enabled = cfg?.enabled ?? true
  form.processes = (cfg?.processes ?? []).map((p) => ({
    title: p.title ?? '',
    owner_id: p.owner_id ?? null,
    color: p.color ?? '',
    tasks: (p.tasks ?? []).map((t) => ({
      title: t.title ?? '',
      color: t.color ?? '',
      resources: (t.resources ?? []).map((r) => ({ resource_id: r.resource_id ?? 0, quantity: r.quantity ?? 1 })),
      operations: (t.operations ?? []).map((o) => ({ title: o.title ?? '' })),
    })),
  }))
  dirty.value = false
  saving.value = false
  previewOpen.value = false
}

watch(autoCreateConfig, () => {
  // Reload the form when the config arrives/changes externally.
  if (autoCreateConfig.value) resetForm()
})

async function reload() {
  await app.loadAutoCreateConfig()
  if (autoCreateConfig.value) {
    if (!users.value.length) await app.loadUsers()
    if (!resources.value.length) await app.loadResources()
    resetForm()
  }
}

onMounted(() => {
  void reload()
  window.addEventListener('beforeunload', onBeforeUnload)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
})

// === Unsaved-changes protection (U1) ===
let allowLeave = false

/** Browser close/reload with unsaved changes — native confirmation */
function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}

/** Route change with unsaved changes — in-app confirmation dialog */
onBeforeRouteLeave((_to, _from, next) => {
  if (!dirty.value || allowLeave) {
    next()
    return
  }
  ask(t('adminConfig.autoCreate.leaveTitle'), () => {
    allowLeave = true
    next()
  }, t('adminConfig.autoCreate.leaveConfirm'))
  // Navigation stays pending until the user decides (next() in the callback).
})

function addProcess() {
  form.processes.push({ title: '', owner_id: null, color: '', tasks: [] })
  dirty.value = true
}

/** Removes a process; a process with tasks asks for confirmation first */
function removeProcess(i: number) {
  const p = form.processes[i]
  if (!p) return
  if (p.tasks.length) {
    ask(t('adminConfig.autoCreate.confirmRemoveProcess', { name: p.title || `#${i + 1}`, count: p.tasks.length }), () => {
      form.processes.splice(i, 1)
      dirty.value = true
    }, t('common.delete'))
    return
  }
  form.processes.splice(i, 1)
  dirty.value = true
}

/** Swaps a process with its neighbour (order is shown in the scheduler) */
function moveProcess(i: number, dir: -1 | 1) {
  const target = i + dir
  if (target < 0 || target >= form.processes.length) return
  const tmp = form.processes[i]
  form.processes[i] = form.processes[target]
  form.processes[target] = tmp
  dirty.value = true
}

function addTask(p: LocalProcess) {
  p.tasks.push({ title: '', color: NEUTRAL_TASK_COLOR, resources: [], operations: [] })
  dirty.value = true
}

/** Removes a task; a task with resources or operations asks for confirmation first */
function removeTask(p: LocalProcess, ti: number) {
  const task = p.tasks[ti]
  if (!task) return
  const children = task.resources.length + task.operations.length
  if (children) {
    ask(t('adminConfig.autoCreate.confirmRemoveTask', { name: task.title || `#${ti + 1}`, count: children }), () => {
      p.tasks.splice(ti, 1)
      dirty.value = true
    }, t('common.delete'))
    return
  }
  p.tasks.splice(ti, 1)
  dirty.value = true
}

/** Swaps a task with its neighbour within the process */
function moveTask(pi: number, ti: number, dir: -1 | 1) {
  const p = form.processes[pi]
  const target = ti + dir
  if (!p || target < 0 || target >= p.tasks.length) return
  const tmp = p.tasks[ti]
  p.tasks[ti] = p.tasks[target]
  p.tasks[target] = tmp
  dirty.value = true
}

function addResource(t: LocalTask) {
  t.resources.push({ resource_id: 0, quantity: 1 })
  dirty.value = true
}
function removeResource(t: LocalTask, ri: number) {
  t.resources.splice(ri, 1)
  dirty.value = true
}

function addOperation(t: LocalTask) {
  t.operations.push({ title: '' })
  dirty.value = true
}
function removeOperation(t: LocalTask, oi: number) {
  t.operations.splice(oi, 1)
  dirty.value = true
}

function validate(): string | null {
  if (form.processes.length > LIMITS.maxProcesses) {
    return t('adminConfig.autoCreate.limitProcesses', { max: LIMITS.maxProcesses })
  }
  let totalAssignments = 0
  for (let pi = 0; pi < form.processes.length; pi++) {
    const p = form.processes[pi]
    if (!p.title.trim()) return t('adminConfig.autoCreate.validationProcessTitle', { n: pi + 1 })
    if (p.tasks.length > LIMITS.maxTasksPerProcess) {
      return t('adminConfig.autoCreate.validationProcessTasks', { name: p.title, max: LIMITS.maxTasksPerProcess })
    }
    for (let ti = 0; ti < p.tasks.length; ti++) {
      const task = p.tasks[ti]
      if (!task.title.trim()) {
        return t('adminConfig.autoCreate.validationTaskTitle', { process: p.title, n: ti + 1 })
      }
      if (task.resources.length > LIMITS.maxResourcesPerTask) {
        return t('adminConfig.autoCreate.validationTaskResources', { name: task.title, max: LIMITS.maxResourcesPerTask })
      }
      if (task.operations.length > LIMITS.maxOperationsPerTask) {
        return t('adminConfig.autoCreate.validationTaskOperations', { name: task.title, max: LIMITS.maxOperationsPerTask })
      }
      for (let oi = 0; oi < task.operations.length; oi++) {
        if (!task.operations[oi].title.trim()) {
          return t('adminConfig.autoCreate.validationOperationTitle', { name: task.title, n: oi + 1 })
        }
      }
      totalAssignments += task.resources.length
      const seen = new Set<number>()
      for (let ri = 0; ri < task.resources.length; ri++) {
        const r = task.resources[ri]
        if (!r.resource_id) return t('adminConfig.autoCreate.validationResourcePick', { name: task.title, n: ri + 1 })
        if (seen.has(r.resource_id)) {
          return t('adminConfig.autoCreate.validationResourceDuplicate', { name: task.title, resource: resourceLabel(r.resource_id) })
        }
        if (r.quantity <= 0) return t('adminConfig.autoCreate.validationQuantityMin', { name: task.title })
        if (r.quantity > LIMITS.maxQuantity) {
          return t('adminConfig.autoCreate.validationQuantityMax', { name: task.title, max: LIMITS.maxQuantity })
        }
        seen.add(r.resource_id)
      }
    }
  }
  if (totalAssignments > LIMITS.maxAssignmentsTotal) {
    return t('adminConfig.autoCreate.limitAssignments', { max: LIMITS.maxAssignmentsTotal })
  }
  return null
}

async function onSave() {
  if (!canConfigure.value || saving.value || !dirty.value) return
  const err = validate()
  if (err) {
    notifyError(err)
    return
  }
  saving.value = true
  const ok = await app.saveAutoCreateConfig({
    enabled: form.enabled,
    processes: form.processes.map((p) => ({
      title: p.title.trim(),
      owner_id: p.owner_id ?? undefined,
      color: p.color || undefined,
      tasks: p.tasks.map((t) => ({
        title: t.title.trim(),
        // The two-type scheme is explicit in the payload: accent keeps its
        // vivid color, neutral always stores the shared background tone.
        color: isAccentTask(t.color) ? (t.color || undefined) : NEUTRAL_TASK_COLOR,
        resources: t.resources.map((r) => ({ resource_id: r.resource_id, quantity: r.quantity })),
        operations: t.operations
          .filter((o) => o.title.trim() !== '')
          .map((o) => ({ title: o.title.trim() })),
      })),
    })),
  })
  saving.value = false
  // Summary only: the raw API error on failure is surfaced by the global
  // toast (http.ts), so the notification stays a generic custom summary.
  if (ok) notifySuccess(t('adminConfig.autoCreate.saved'))
  else notifyError(t('adminConfig.autoCreate.saveFailed'))
  if (ok) dirty.value = false
}
</script>

<template>
  <section class="ac">
    <div class="ac-head">
      <h2 class="ac-title">{{ t('adminConfig.autoCreate.title') }}</h2>
      <HintButton hint="auto-create" />
    </div>

    <p v-if="autoCreateLoading && !autoCreateConfig" class="ac-st">{{ t('adminConfig.autoCreate.loading') }}</p>

    <div v-else-if="autoCreateError && !autoCreateConfig" class="ac-st ac-er" role="alert">
      {{ t('adminConfig.autoCreate.loadError', { error: autoCreateError }) }}
      <button type="button" class="ac-retry" @click="reload">{{ t('adminConfig.autoCreate.retry') }}</button>
    </div>

    <p v-if="autoCreateConfig && !canConfigure" class="ac-st" role="note">{{ t('adminConfig.autoCreate.readOnly') }}</p>
    <fieldset v-if="autoCreateConfig" class="ac-form" :disabled="!canConfigure">
      <label class="ac-enable">
        <input type="checkbox" v-model="form.enabled" @change="dirty = true" />
        {{ t('adminConfig.autoCreate.enabled') }}
      </label>

      <!-- Live preview of what a new project will get from the template -->
      <div class="ac-preview">
        <button type="button" class="ac-preview-toggle" @click="previewOpen = !previewOpen" :aria-expanded="previewOpen">
          {{ t('adminConfig.autoCreate.preview', { processes: preview.processes, tasks: preview.tasks, operations: preview.operations, assignments: preview.assignments }) }}
          <span class="ac-preview-caret">{{ previewOpen ? '▾' : '▸' }}</span>
        </button>
        <div v-if="!form.enabled" class="ac-preview-off">{{ t('adminConfig.autoCreate.previewOff') }}</div>
        <div v-if="previewOpen" class="ac-preview-tree">
          <div v-if="!form.processes.length" class="ac-preview-empty">
            {{ t('adminConfig.autoCreate.previewEmpty') }}
          </div>
          <div v-for="(p, pi) in form.processes" :key="pi" class="ac-preview-node">
            <div class="ac-preview-p">{{ p.title || t('adminConfig.autoCreate.processFallback', { n: pi + 1 }) }}</div>
            <div v-for="(tsk, ti) in p.tasks" :key="ti" class="ac-preview-task">
              <span
                class="ac-swatch"
                :style="{ background: isAccentTask(tsk.color) ? (tsk.color || 'var(--ui-accent)') : NEUTRAL_TASK_COLOR }"
              />
              <span class="ac-preview-t">{{ tsk.title || t('adminConfig.autoCreate.taskFallback', { n: ti + 1 }) }}</span>
              <span v-if="tsk.resources.length" class="ac-preview-res">
                {{ tsk.resources.map((r) => `${resourceLabel(r.resource_id)} × ${r.quantity}`).join(', ') }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div v-for="(p, pi) in form.processes" :key="pi" class="ac-process">
        <div class="ac-process-head">
          <button type="button" class="ac-move" :disabled="pi === 0" @click="moveProcess(pi, -1)" :aria-label="t('adminConfig.autoCreate.moveProcessUp')">↑</button>
          <button type="button" class="ac-move" :disabled="pi === form.processes.length - 1" @click="moveProcess(pi, 1)" :aria-label="t('adminConfig.autoCreate.moveProcessDown')">↓</button>
          <input v-model="p.title" type="text" class="ac-input ac-title-input" :placeholder="t('adminConfig.autoCreate.processTitlePlaceholder')" :aria-label="t('adminConfig.autoCreate.processTitlePlaceholder')" @input="dirty = true" />
          <ColorField v-model="p.color" size="sm" :label="t('adminConfig.autoCreate.processColorLabel')" class="ac-color" @update:model-value="dirty = true" />
          <select v-model="p.owner_id" class="ac-input ac-owner" :aria-label="t('adminConfig.autoCreate.ownerAria')" @change="dirty = true">
            <option :value="null">{{ t('adminConfig.autoCreate.ownerNone') }}</option>
            <option v-for="opt in ownerOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <button type="button" class="ac-del" @click="removeProcess(pi)">{{ t('adminConfig.autoCreate.removeProcess') }}</button>
        </div>
        <p v-if="p.owner_id == null" class="ac-owner-hint">{{ t('adminConfig.autoCreate.ownerHint') }}</p>

        <div class="ac-tasks">
          <div v-for="(tsk, ti) in p.tasks" :key="ti" class="ac-task">
            <div class="ac-task-head">
              <button type="button" class="ac-move" :disabled="ti === 0" @click="moveTask(pi, ti, -1)" :aria-label="t('adminConfig.autoCreate.moveTaskUp')">↑</button>
              <button type="button" class="ac-move" :disabled="ti === p.tasks.length - 1" @click="moveTask(pi, ti, 1)" :aria-label="t('adminConfig.autoCreate.moveTaskDown')">↓</button>
              <input v-model="tsk.title" type="text" class="ac-input" :placeholder="t('adminConfig.autoCreate.taskTitlePlaceholder')" :aria-label="t('adminConfig.autoCreate.taskTitlePlaceholder')" @input="dirty = true" />
              <div class="ac-type" role="group" :aria-label="t('adminConfig.autoCreate.taskTypeAria', { name: tsk.title || ti + 1 })">
                <button
                  type="button"
                  class="ac-type-btn"
                  :class="{ active: !isAccentTask(tsk.color) }"
                  @click="setTaskType(tsk, 'neutral')"
                >
                  {{ t('adminConfig.autoCreate.taskTypeNeutral') }}
                </button>
                <button
                  type="button"
                  class="ac-type-btn"
                  :class="{ active: isAccentTask(tsk.color) }"
                  @click="setTaskType(tsk, 'accent')"
                >
                  {{ t('adminConfig.autoCreate.taskTypeAccent') }}
                </button>
              </div>
              <ColorField
                v-if="isAccentTask(tsk.color)"
                v-model="tsk.color"
                size="sm"
                :label="t('adminConfig.autoCreate.taskColorLabel')"
                class="ac-color"
                @update:model-value="dirty = true"
              />
              <span
                v-else
                class="ac-swatch ac-swatch-neutral"
                :style="{ background: NEUTRAL_TASK_COLOR }"
                :title="t('adminConfig.autoCreate.neutralColorTitle', { color: NEUTRAL_TASK_COLOR })"
              />
              <button type="button" class="ac-del" @click="removeTask(p, ti)">×</button>
            </div>
            <div v-if="tsk.resources.length" class="ac-resources">
              <div v-for="(r, ri) in tsk.resources" :key="ri" class="ac-resource">
                <select v-model="r.resource_id" class="ac-input" :aria-label="t('adminConfig.autoCreate.resourceAria')" @change="dirty = true">
                  <option :value="0">{{ t('adminConfig.autoCreate.resourceSelect') }}</option>
                  <option v-for="opt in resourceOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
                </select>
                <input v-model.number="r.quantity" type="number" min="1" :max="LIMITS.maxQuantity" class="ac-input ac-qty" :aria-label="t('adminConfig.autoCreate.quantityAria')" @input="dirty = true" />
                <button type="button" class="ac-del" @click="removeResource(tsk, ri)">×</button>
              </div>
            </div>
            <button type="button" class="ac-add-sm" @click="addResource(tsk)">{{ t('adminConfig.autoCreate.addResource') }}</button>
            <div v-if="tsk.operations.length" class="ac-operations">
              <div v-for="(o, oi) in tsk.operations" :key="oi" class="ac-operation">
                <input v-model="o.title" type="text" class="ac-input" :placeholder="t('adminConfig.autoCreate.operationTitlePlaceholder')" :aria-label="t('adminConfig.autoCreate.operationTitlePlaceholder')" @input="dirty = true" />
                <button type="button" class="ac-del" @click="removeOperation(tsk, oi)" :aria-label="t('adminConfig.autoCreate.removeOperationAria', { n: oi + 1 })">×</button>
              </div>
            </div>
            <button type="button" class="ac-add-sm" @click="addOperation(tsk)">{{ t('adminConfig.autoCreate.addOperation') }}</button>
          </div>
          <button type="button" class="ac-add-sm" @click="addTask(p)">{{ t('adminConfig.autoCreate.addTask') }}</button>
        </div>
      </div>

      <button type="button" class="ac-add" @click="addProcess">{{ t('adminConfig.autoCreate.addProcess') }}</button>

      <div class="ac-actions">
        <button v-if="canConfigure" type="button" class="ac-save" :disabled="saving || !dirty" @click="onSave">{{ t('adminConfig.autoCreate.save') }}</button>
        <button v-if="canConfigure && dirty" type="button" class="ac-cancel" :disabled="saving" @click="resetForm">{{ t('adminConfig.autoCreate.cancel') }}</button>
      </div>
    </fieldset>

    <ConfirmDialog
      :open="!!confirmDialog"
      :message="confirmDialog?.message ?? ''"
      :confirm-label="confirmDialog?.confirmLabel"
      @confirm="proceed"
      @close="cancel"
    />
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.ac-head {
  margin-bottom: 20px;

  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.ac-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0 0 6px;
}
.ac-st {
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.ac-st.ac-er {
  color: var(--ui-danger);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.ac-retry {
  border: 1px solid var(--ui-danger-soft);
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  border-radius: var(--ui-radius-sm);
  padding: 7px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  cursor: pointer;
}
.ac-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.ac-enable {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  color: var(--ui-text);
}
.ac-preview {
  background: var(--ui-surface-2);
  border: 1px dashed var(--ui-border-strong);
  border-radius: 10px;
  padding: 10px 14px;
}
.ac-preview-toggle {
  border: none;
  background: transparent;
  padding: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-accent);
  cursor: pointer;
  font-family: inherit;
}
.ac-preview-caret {
  margin-left: 4px;
  color: var(--ui-text-muted);
}
.ac-preview-off {
  margin-top: 8px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-warning);
  font-weight: 600;
}
.ac-preview-tree {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}
.ac-preview-empty {
  color: var(--ui-text-muted);
}
.ac-preview-p {
  font-weight: 600;
  color: var(--ui-text);
}
.ac-preview-task {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding-left: 14px;
}
.ac-swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid var(--ui-border);
}
.ac-swatch-neutral {
  width: 16px;
  height: 16px;
  border-radius: 999px;
}
.ac-type {
  display: inline-flex;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  overflow: hidden;
  flex: none;
}
.ac-type-btn {
  border: none;
  background: var(--ui-surface);
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  padding: 6px 10px;
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration);
}
.ac-type-btn + .ac-type-btn {
  border-left: 1px solid var(--ui-border-strong);
}
.ac-type-btn.active {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 700;
}
.ac-preview-t {
  color: var(--ui-text-2);
}
.ac-preview-res {
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}
.ac-process {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-md);
  padding: 16px;
}
.ac-process-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.ac-title-input {
  flex: 1;
}
.ac-owner {
  width: 240px;
}
.ac-owner-hint {
  margin: -6px 0 10px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
}
.ac-tasks {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-left: 8px;
  border-left: 2px solid var(--ui-border);
}
.ac-task {
  background: var(--ui-surface-2);
  border-radius: var(--ui-radius-sm);
  padding: 10px;
}
.ac-task-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ac-task-head .ac-input {
  flex: 1;
}
.ac-move {
  border: 1px solid var(--ui-border-strong);
  border-radius: 6px;
  background: var(--ui-surface);
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  line-height: 1;
  cursor: pointer;
  padding: 4px 7px;
}
.ac-move:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ac-resources {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding-left: 8px;
}
.ac-resource {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Operations (subtasks) of a template task */
.ac-operations {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
  padding-left: 8px;
}
.ac-operation {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ac-operation .ac-input {
  flex: 1;
}
.ac-resource select {
  flex: 1;
}
.ac-qty {
  width: 70px;
}
.ac-input {
  box-sizing: border-box;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 8px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
}
.ac-input:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px rgba(26, 115, 232, 0.12);
}
.ac-add,
.ac-add-sm {
  border: 1px solid var(--ui-accent-soft);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  border-radius: var(--ui-radius-sm);
  padding: 7px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  cursor: pointer;
  align-self: flex-start;
}
.ac-add-sm {
  padding: 5px 10px;
  margin-top: 4px;
}
.ac-del {
  border: none;
  background: transparent;
  color: var(--ui-danger);
  font-size: calc(var(--ui-font-scale, 1) * 15px);
  line-height: 1;
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
}
.ac-del:hover {
  background: var(--ui-danger-soft);
}
.ac-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
.ac-save {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 22px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
}
.ac-save:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.ac-cancel {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  padding: 8px 16px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  color: var(--ui-text-2);
  cursor: pointer;
}
.ac-form { border: 0; margin: 0; padding: 0; min-width: 0; }
</style>