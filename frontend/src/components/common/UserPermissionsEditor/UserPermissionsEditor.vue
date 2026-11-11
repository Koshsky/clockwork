<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRbacStore } from '../../../store'
import type { PermissionCell, PermissionOverride, UserPermissionsModel } from './types'
import {
  GROUPS, ACTIONS, permissionBlocks, permissionActionGroups, SCOPE_OPTIONS, FALLBACK_SCOPE_OPTIONS, resourceTitle, actionTitle,
  resourceDescription, scopeOptionLabel, scopeOptionDescription, scopeLabel, simpleScope, hasAdditionalScope, viewParentResources,
} from './labels'
import { NO_ACCESS, commonPresetScope, type PresetActionGroup } from '@/utils/rbacGrid'
import { scopeMoves } from '@/rbacScope'
import { togglePresetScope } from '@/utils/presetDefaults'
import { applyPermissionGroup, overrideSignature } from './draft'
import { t } from '@/i18n'
import HintButton from '../HintButton/HintButton.vue'
import TooltipCell from '../TooltipCell/TooltipCell.vue'

const props = defineProps<{
  userId: number
  mode?: 'draft' | 'user'
  preset?: string
  presetOptions?: Array<{ value: string; label: string }>
  preview?: UserPermissionsModel | null
  busy?: boolean
}>()

const emit = defineEmits<{
  (e: 'update:overrides', overrides: PermissionOverride[]): void
  (e: 'update:dirty', dirty: boolean): void
  (e: 'update:preset', preset: string): void
}>()

const rbac = useRbacStore()
const isDraft = computed(() => props.mode === 'draft')
const root = ref<HTMLElement | null>(null)
const singleColumn = ref(false)
let resizeObserver: ResizeObserver | undefined

function cellsOf(preset: string): PermissionCell[] {
  return rbac.matrix.filter((cell) => cell.preset === preset && cell.resource && cell.action)
    .map((cell) => ({ resource: cell.resource ?? '', action: cell.action ?? '', scope: cell.scope ?? '' }))
}

const model = computed<UserPermissionsModel | null>(() => {
  if (props.preview) return props.preview
  if (isDraft.value) {
    const preset = props.preset ?? ''
    const cells = cellsOf(preset)
    return { preset, admin: preset === 'admin', overrides: [], presetScope: cells, effective: cells }
  }
  const saved = rbac.userPermissions
  if (!saved || saved.user_id !== props.userId) return null
  const preset = props.preset ?? saved.preset ?? null
  return {
    preset,
    admin: preset === 'admin' || (!!saved.admin && preset === saved.preset),
    overrides: (saved.overrides ?? []).map((rule) => ({
      resource: rule.resource, action: rule.action, scope: rule.scope ?? '', granted: rule.granted ?? false,
    })),
    presetScope: rbac.matrix.length ? cellsOf(preset ?? '') : (saved.preset_scope ?? []).map((cell) => ({
      resource: cell.resource ?? '', action: cell.action ?? '', scope: cell.scope ?? '',
    })),
    effective: [],
  }
})

const loading = computed(() => !isDraft.value && rbac.userPermissionsLoading)
const loadError = computed(() => isDraft.value ? null : rbac.userPermissionsError)
const staged = reactive<Record<string, PermissionOverride>>({})
const savedOverrides = ref<PermissionOverride[]>([])
let loadedUserId: number | null = null
function key(resource: string, action: string) { return `${resource}/${action}` }
const overridesList = computed(() => Object.values(staged).map((rule) => ({ ...rule })))
const dirty = computed(() => overrideSignature(overridesList.value) !== overrideSignature(savedOverrides.value))

function replaceDraft(overrides: readonly PermissionOverride[]) {
  for (const entry of Object.keys(staged)) delete staged[entry]
  for (const rule of overrides) staged[key(rule.resource, rule.action)] = { ...rule }
}

watch(model, (next) => {
  if (!next) return
  const sameUser = loadedUserId === props.userId
  if (!isDraft.value && sameUser && overrideSignature(next.overrides) === overrideSignature(savedOverrides.value)) return
  loadedUserId = props.userId
  savedOverrides.value = next.overrides.map((rule) => ({ ...rule }))
  replaceDraft(next.overrides)
}, { immediate: true })
watch(overridesList, (overrides) => emit('update:overrides', overrides), { deep: true, immediate: true })
watch(dirty, (value) => emit('update:dirty', value), { immediate: true })

const baseline = computed(() => model.value?.presetScope ?? [])
function presetZone(resource: string, action: string): string {
  const scope = baseline.value.find((cell) => cell.resource === resource && cell.action === action)?.scope ?? ''
  return scope === NO_ACCESS ? '' : scope
}
function effectiveZone(resource: string, action: string): string {
  const override = staged[key(resource, action)]
  return override ? override.granted ? override.scope ?? '' : '' : presetZone(resource, action)
}

const editorCells = computed(() => {
  if (rbac.matrix.length && !props.preview) return rbac.matrix
  const fallback = GROUPS.flatMap((group) => group.resources.flatMap((resource) =>
    [...ACTIONS, ...(resource === 'project' ? ['prioritize'] : [])].map((action) => ({ resource, action })),
  ))
  return [...fallback, ...baseline.value, ...overridesList.value]
})
const blocks = computed(() => permissionBlocks(editorCells.value))
const blockColumns = computed(() => singleColumn.value ? [blocks.value] : [
  blocks.value.filter((block) => block.index % 2 === 0),
  blocks.value.filter((block) => block.index % 2 === 1),
])
function actionGroups(resource: string) {
  const groups = permissionActionGroups(resource, editorCells.value)
  const order = ['view', 'manage', 'prioritize']
  return groups.sort((a, b) => (order.indexOf(a.key) < 0 ? order.length : order.indexOf(a.key)) -
    (order.indexOf(b.key) < 0 ? order.length : order.indexOf(b.key)))
}
function groupTitle(group: PresetActionGroup) {
  if (group.title) return t(`adminConfig.administration.title.${group.title}`)
  return group.key === 'manage' ? t('adminConfig.presets.manage') : actionTitle(group.key)
}
function groupScope(resource: string, group: PresetActionGroup) {
  return commonPresetScope(group.actions.map((action) => simpleScope(resource, effectiveZone(resource, action))))
}
function inheritedViewScopes(resource: string) {
  return viewParentResources(resource).map((parent) => effectiveZone(parent, 'view'))
    .filter((scope) => scope && scope !== NO_ACCESS)
}
function locked(resource: string, group: PresetActionGroup) {
  return group.key === 'view' && inheritedViewScopes(resource).includes('all')
}
function isChipOn(resource: string, group: PresetActionGroup, value: string) {
  if (locked(resource, group)) return value === 'all'
  const scope = groupScope(resource, group)
  return value === NO_ACCESS ? scope === NO_ACCESS : scopeMoves(scope ?? '').includes(value)
}
function groupChanged(resource: string, group: PresetActionGroup) {
  return group.actions.some((action) => overrideSignature(overridesList.value.filter((rule) => rule.resource === resource && rule.action === action)) !==
    overrideSignature(savedOverrides.value.filter((rule) => rule.resource === resource && rule.action === action)))
}
function groupIndividual(resource: string, group: PresetActionGroup) {
  return group.actions.some((action) => !!staged[key(resource, action)])
}
function chooseScope(resource: string, group: PresetActionGroup, value: string) {
  if (props.busy || locked(resource, group)) return
  const scope = groupScope(resource, group)
  if (value === NO_ACCESS && scope === NO_ACCESS) return
  const next = value === NO_ACCESS || scope === null || hasAdditionalScope(resource, scope)
    ? value : togglePresetScope(scope, value)
  replaceDraft(applyPermissionGroup(overridesList.value, baseline.value, resource, group.actions, next))
}
function revertGroup(resource: string, group: PresetActionGroup) {
  if (props.busy || locked(resource, group)) return
  replaceDraft(overridesList.value.filter((rule) => rule.resource !== resource || !group.actions.includes(rule.action)))
}
function cancelChanges() { replaceDraft(savedOverrides.value) }
function resetAll() { replaceDraft([]) }
defineExpose({ cancelChanges, resetAll })

function ensureLoaded(id: number) {
  if (props.preview) return
  if (!rbac.matrix.length && !rbac.loading) void rbac.loadRbac()
  if (!isDraft.value && id > 0 && rbac.userPermissions?.user_id !== id) void rbac.loadUserPermissions(id)
}
onMounted(() => {
  ensureLoaded(props.userId)
  if (root.value) {
    singleColumn.value = root.value.clientWidth < 780
    resizeObserver = new ResizeObserver(([entry]) => { singleColumn.value = entry.contentRect.width < 780 })
    resizeObserver.observe(root.value)
  }
})
watch(() => props.userId, ensureLoaded)
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <section ref="root" class="uped">
    <div class="uped-head">
      <div class="uped-heading">
        <h3 class="uped-title">{{ t('adminConfig.editor.title') }}</h3>
        <HintButton hint="permissions-editor" />
      </div>
      <div class="uped-tools">
        <label v-if="presetOptions?.length" class="uped-role">
          <span>{{ t('adminConfig.editor.role') }}</span>
          <select class="uped-preset-select" :value="preset ?? model?.preset ?? ''" :disabled="busy" :aria-label="t('adminConfig.editor.presetAria')"
            @change="$emit('update:preset', ($event.target as HTMLSelectElement).value)">
            <option v-for="opt in presetOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </label>
        <button class="uped-reset" type="button" :disabled="busy || !overridesList.length" @click="resetAll">{{ t('adminConfig.editor.resetIndividual') }}</button>
      </div>
    </div>
    <p v-if="!isDraft && !preview && model && !model.admin" class="ur-action-hint">{{ t('adminConfig.editor.roleHint') }}</p>
    <p v-if="dirty" class="uped-dirty" role="status">{{ t('adminConfig.editor.dirty') }}</p>
    <p v-if="loading && !model" class="uped-st">{{ t('adminConfig.editor.loading') }}</p>
    <p v-if="loadError" class="uped-st er" role="alert">{{ loadError }}</p>
    <div v-if="model?.admin" class="uped-admin" role="note">{{ t('adminConfig.editor.adminNote') }}</div>
    <div v-else-if="model" class="uped-list">
      <div v-for="(column, columnIndex) in blockColumns" :key="columnIndex" class="uped-column">
        <div v-for="{ resource, group, index } in column" :key="resource" class="uped-res-card" :data-resource="resource" :data-order="index">
          <div class="uped-res-head">
            <h4 class="uped-res-title">{{ resourceTitle(resource) }}</h4>
            <span class="uped-group-title">{{ t(`adminConfig.perm.group.${group}`) }}</span>
          </div>
          <p v-if="resourceDescription(resource)" class="uped-resource-description">{{ resourceDescription(resource) }}</p>
          <div class="uped-actions" :class="{ 'uped-actions--project': resource === 'project', 'uped-actions--administration': resource === 'administration' }">
            <div v-for="actionGroup in actionGroups(resource)" :key="actionGroup.key" class="ur-row"
              :data-action-group="actionGroup.key" :data-capability-resource="actionGroup.resource" :class="{ changed: groupChanged(actionGroup.resource, actionGroup) }">
              <div class="ur-action-head">
                <span class="ur-cap">{{ groupTitle(actionGroup) }}</span>
                <span v-if="actionGroup.description" class="ur-action-hint">{{ t(`adminConfig.administration.description.${actionGroup.description}`) }}</span>
                <span v-else-if="actionGroup.key === 'manage'" class="ur-action-hint">{{ t('adminConfig.presets.manageHint') }}</span>
              </div>
              <p v-if="actionGroup.key === 'view' && inheritedViewScopes(actionGroup.resource).length" class="ur-inherited">
                {{ t(locked(actionGroup.resource, actionGroup) ? 'adminConfig.presets.inheritedLocked' : 'adminConfig.presets.inheritedView') }}
              </p>
              <details v-if="groupScope(actionGroup.resource, actionGroup) === null" class="ur-mixed">
                <summary>{{ t('adminConfig.presets.mixed') }}</summary>
                <ul><li v-for="action in actionGroup.actions" :key="action">{{ actionTitle(action) }}: {{ effectiveZone(actionGroup.resource, action) ? scopeLabel(actionGroup.resource, effectiveZone(actionGroup.resource, action)) : t('adminConfig.presets.revokeChip') }}</li></ul>
                <p>{{ t('adminConfig.presets.mixedHint') }}</p>
              </details>
              <p v-else-if="hasAdditionalScope(actionGroup.resource, groupScope(actionGroup.resource, actionGroup) ?? '')" class="ur-action-hint">
                {{ t('adminConfig.presets.savedCondition') }}: {{ scopeLabel(actionGroup.resource, groupScope(actionGroup.resource, actionGroup) ?? '') }}
              </p>
              <TooltipCell class="ur-choice-tooltip" :text="t('adminConfig.presets.inheritedTooltip')" :disabled="!locked(actionGroup.resource, actionGroup)"
                :tabindex="locked(actionGroup.resource, actionGroup) ? 0 : undefined"
                :aria-label="locked(actionGroup.resource, actionGroup) ? t('adminConfig.presets.inheritedTooltip') : undefined" multiline>
                <template #popup><span class="ur-inherited-tooltip">{{ t('adminConfig.presets.inheritedTooltip') }}</span></template>
                <div class="ur-chips" :class="{ 'ur-chips--inherited': locked(actionGroup.resource, actionGroup) }">
                  <button v-for="opt in SCOPE_OPTIONS[actionGroup.resource] ?? FALLBACK_SCOPE_OPTIONS" :key="opt.value" type="button" class="ur-chip"
                    :class="{ on: isChipOn(actionGroup.resource, actionGroup, opt.value) }" :data-scope="opt.value" :disabled="busy || locked(actionGroup.resource, actionGroup)"
                    :aria-pressed="isChipOn(actionGroup.resource, actionGroup, opt.value)" :title="scopeOptionDescription(actionGroup.resource, opt.value)"
                    @click="chooseScope(actionGroup.resource, actionGroup, opt.value)">{{ resource === 'administration' ? t('adminConfig.administration.allowed') : scopeOptionLabel(actionGroup.resource, opt.value) }}</button>
                  <button type="button" class="ur-chip rev" data-scope="none" :disabled="busy || locked(actionGroup.resource, actionGroup)"
                    :class="{ on: isChipOn(actionGroup.resource, actionGroup, NO_ACCESS) }" :aria-pressed="isChipOn(actionGroup.resource, actionGroup, NO_ACCESS)"
                    @click="chooseScope(actionGroup.resource, actionGroup, NO_ACCESS)">{{ t(actionGroup.key === 'view' && inheritedViewScopes(actionGroup.resource).length ? 'adminConfig.presets.onlyInherited' : 'adminConfig.presets.revokeChip') }}</button>
                </div>
              </TooltipCell>
              <button v-if="groupIndividual(actionGroup.resource, actionGroup)" type="button" class="ur-revert" :disabled="busy || locked(actionGroup.resource, actionGroup)" @click="revertGroup(actionGroup.resource, actionGroup)">{{ t('adminConfig.editor.revertToRole') }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import '../../../styles/tokens.css';
.uped { display: flex; flex-direction: column; gap: 16px; min-width: 0; container-type: inline-size; }
.uped-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.uped-heading, .uped-tools { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.uped-title { margin: 0; color: var(--ui-text); font-size: calc(var(--ui-font-scale, 1) * 16px); font-weight: 600; }
.uped-heading :deep(.hb) { border: 1px solid var(--ui-border-strong); background: var(--ui-surface); color: var(--ui-text-muted); box-shadow: none; }
.uped-role { display: flex; align-items: center; gap: 8px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 12px); }
.uped-preset-select, .uped-reset { border: 1px solid var(--ui-border-strong); background: var(--ui-surface); color: var(--ui-text-2); border-radius: var(--ui-radius-sm); padding: 8px 11px; font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); }
.uped-preset-select { max-width: 280px; cursor: pointer; }
.uped-reset { cursor: pointer; }
.uped-reset:not(:disabled):hover, .uped-preset-select:not(:disabled):hover { border-color: var(--ui-accent); }
.uped-reset:disabled, .uped-preset-select:disabled { opacity: .5; cursor: not-allowed; }
.uped-dirty, .uped-st, .uped-admin { margin: 0; font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-muted); }
.uped-dirty { color: var(--ui-accent); }
.uped-admin { border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); background: var(--ui-surface); padding: 18px; }
.er { color: var(--ui-danger); }
.uped-list { display: flex; align-items: flex-start; gap: 16px; min-width: 0; }
.uped-column { display: flex; flex-direction: column; gap: 16px; flex: 1; min-width: 0; }
.uped-res-card { background: var(--ui-surface); border: 1px solid var(--ui-border); border-radius: var(--ui-radius-md); box-shadow: var(--ui-shadow-sm); overflow: hidden; }
.uped-res-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--ui-border); }
.uped-res-title { margin: 0; font-size: calc(var(--ui-font-scale, 1) * 13px); font-weight: 600; color: var(--ui-text); }
.uped-group-title { color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 10px); }
.uped-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.uped-actions--project { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.ur-row { display: flex; flex-direction: column; align-items: stretch; gap: 8px; min-width: 0; padding: 12px; }
.ur-row + .ur-row { border-left: 1px solid var(--ui-border); }
.ur-row.changed { background: var(--ui-warning-soft); }
.ur-action-head { display: flex; flex-direction: column; gap: 3px; min-height: 34px; }
.ur-cap { font-size: calc(var(--ui-font-scale, 1) * 12px); color: var(--ui-text); }
.ur-action-hint, .ur-inherited, .ur-mixed { margin: 0; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 11px); line-height: 1.45; }
.ur-mixed { padding: 8px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); background: var(--ui-surface-2); }
.ur-mixed summary { cursor: pointer; }
.ur-mixed ul { margin: 6px 0; padding-left: 16px; }
.ur-choice-tooltip { display: block; min-width: 0; }
.ur-chips { display: flex; flex-direction: column; align-items: stretch; gap: 5px; min-width: 0; }
.ur-chip { border: 1px solid var(--ui-border-strong); border-radius: var(--ui-radius-sm); background: var(--ui-surface); padding: 6px 9px; font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); color: var(--ui-text-2); text-align: left; white-space: normal; overflow-wrap: anywhere; cursor: pointer; transition: background .12s, border-color .12s, color .12s; }
.ur-chip:not(:disabled):hover { border-color: var(--ui-accent); background: var(--ui-surface-2); }
.ur-chip.on { background: var(--ui-accent-soft); color: var(--ui-accent); border-color: var(--ui-accent); font-weight: 500; }
.ur-chips--inherited { cursor: not-allowed; }
.ur-chip:disabled { pointer-events: none; opacity: .55; cursor: not-allowed; color: var(--ui-text-muted); background: var(--ui-surface-2); border-color: var(--ui-border); }
.ur-chip.on:disabled { opacity: .85; color: var(--ui-text-2); background: var(--ui-surface-3); border-color: var(--ui-border-strong); }
.ur-inherited-tooltip { white-space: pre-line; }
.ur-revert { align-self: flex-start; padding: 0; border: 0; color: var(--ui-text-muted); font: inherit; font-size: calc(var(--ui-font-scale, 1) * 11px); background: transparent; cursor: pointer; text-align: left; }
.ur-revert:not(:disabled):hover { color: var(--ui-accent); }
.ur-revert:disabled { opacity: .5; cursor: not-allowed; }
@container (max-width: 420px) {
  .uped-head, .uped-tools { align-items: stretch; flex-direction: column; }
  .uped-preset-select { width: 100%; max-width: none; }
  .uped-role { align-items: stretch; flex-direction: column; }
  .uped-actions--project { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .uped-actions--project .ur-row:last-child { grid-column: 1 / -1; border-top: 1px solid var(--ui-border); border-left: 0; }
}
.uped-actions--administration { display: flex; flex-direction: column; }
.uped-actions--administration > div + div { border-left: 0; border-top: 1px solid var(--ui-border); }
.uped-actions--administration .ur-chips { flex-direction: row; flex-wrap: wrap; }
.uped-resource-description { margin: 0; padding: 10px 14px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 11px); line-height: 1.5; border-bottom: 1px solid var(--ui-border); }
</style>
