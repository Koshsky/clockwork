<script setup lang="ts">
/**
 * Access permissions — a preset-centric editor.
 * Presets on the left, capabilities of the selected preset by section on the right.
 * Scopes are rendered in human language in the resource context
 * ("in own processes", "in own projects", "own only", "all").
 * Source of truth — the matrix on the backend (/api/v1/rbac/*); edits are
 * applied immediately (upsert; "no access" = soft delete).
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { AppIcon, ConfirmDialog, ContextMenu, HintButton, InfoTooltip, ModalForm, TooltipCell } from '../components/common'
import {
  permissionBlocks,
  permissionActionGroups,
  SCOPE_OPTIONS as SCOPE_CHIPS,
  FALLBACK_SCOPE_OPTIONS,
  resourceDescription,
  resourceLabel,
  resourceTitle,
  actionTitle,
  scopeLabel,
  scopeOptionDescription,
  simpleScope,
  hasAdditionalScope,
  viewParentResources,
} from '../components/common/UserPermissionsEditor/labels'
import { NO_ACCESS, cellKey as gridCellKey, scopeByCell, commonPresetScope, type PresetActionGroup } from '../utils/rbacGrid'
import { scopeMoves } from '@/rbacScope'
import { useRbacStore } from '../store'
import { useConfirm } from '../composables/useConfirm'
import { notifyError, notifySuccess } from '../notify/state'
import { presetDisplayName } from '../utils/presets'
import { t } from '@/i18n'
import { togglePresetScope } from '@/utils/presetDefaults'

const rbac = useRbacStore()
const { presets, presetRules, matrix, loading, error, saving } = storeToRefs(rbac)

/** Selected preset (by default — the first one from the catalog, not admin). */
const selected = ref('')
const layoutMedia = window.matchMedia('(max-width: 720px)')
const singleColumn = ref(layoutMedia.matches)
function syncColumnLayout() {
  singleColumn.value = layoutMedia.matches
}


/**
 * Sections and actions of the grid come from the backend payload (the complete
 * effective matrix), so a resource or action the engine gains shows up without
 * a frontend change; the local dictionaries only order and label them.
 */
function actionGroups(resource: string) {
  return permissionActionGroups(resource, matrix.value)
}
const blockColumns = computed(() => {
  const blocks = permissionBlocks(matrix.value)
  // Keep the mobile DOM order aligned with reading and keyboard navigation.
  if (singleColumn.value) return [blocks]
  return [blocks.filter((block) => block.index % 2 === 0), blocks.filter((block) => block.index % 2 === 1)]
})

/** Scope chips of a resource: its dictionary entry, else "all" (applicable to
 *  every resource) so an unknown resource stays editable. */
const SCOPE_DISPLAY_ORDER = ['all', 'up', 'project_owner', 'process_owner', 'sib_project', 'sib', 'up1', 'down', 'process_projects', 'project_resources', 'self']

function scopeChips(resource: string) {
  const options = SCOPE_CHIPS[resource] ?? FALLBACK_SCOPE_OPTIONS
  return [...options].sort((a, b) => SCOPE_DISPLAY_ORDER.indexOf(a.value) - SCOPE_DISPLAY_ORDER.indexOf(b.value))
}

/** Effective cell scope from the matrix (no rule = "no access"). */
const effective = computed<Record<string, string>>(() => scopeByCell(matrix.value))

/** Rule id for deletion. */
const ruleIdByCell = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const rule of presetRules.value) {
    if (rule.id == null) continue
    map[cellKey(rule.preset ?? '', rule.resource ?? '', rule.action ?? '')] = rule.id
  }
  return map
})

function cellKey(preset: string, resource: string, action: string): string {
  return gridCellKey(preset, resource, action)
}

function cellValue(preset: string, resource: string, action: string): string {
  return staged[cellKey(preset, resource, action)] ?? effective.value[cellKey(preset, resource, action)] ?? NO_ACCESS
}

/** Human-readable name of a preset catalog entry: the stored name, else a
 *  fallback for a built-in tag, else the tag itself. */
function presetName(tag: string): string {
  return presetDisplayName(presetEntry(tag) ?? { tag })
}

/** Catalog entry of the selected tag (name/description) or undefined. */
function presetEntry(tag: string) {
  return presets.value.find((p) => p.tag === tag)
}

/** Tooltip lines of a preset: its description, else the tag itself. */
function presetTooltipLines(tag: string): string[] {
  const description = presetEntry(tag)?.description?.trim()
  return description ? [description] : [tag]
}

/** Preset tabs: the catalog without the admin bypass (admin is a code invariant, not an editable tab). */
const presetList = computed(() => {
  const tags: string[] = []
  for (const p of presets.value) {
    if (p.tag && p.tag !== 'admin' && !tags.includes(p.tag)) tags.push(p.tag)
  }
  return tags
})

/** Changed cells. */
const staged = reactive<Record<string, string>>({})
const dirtyKeys = computed<string[]>(() =>
  Object.keys(staged).filter((key) => staged[key] !== (effective.value[key] ?? NO_ACCESS)),
)

/** Canonical form of a scope expression (legacy zones normalize; "all"/"none"
 *  keep their identity — they must never compare equal). */
function canon(scope: string): string {
  return commonPresetScope([scope]) ?? NO_ACCESS
}

function groupScope(resource: string, group: PresetActionGroup): string | null {
  return commonPresetScope(group.actions.map((action) => simpleScope(resource, cellValue(selected.value, resource, action))))
}

function groupTitle(group: PresetActionGroup): string {
  if (group.title) return t(`adminConfig.administration.title.${group.title}`)
  return group.key === 'manage' ? t('adminConfig.presets.manage') : actionTitle(group.key)
}

function inheritedViewScopes(resource: string): string[] {
  return viewParentResources(resource).map((parent) => cellValue(selected.value, parent, 'view'))
    .filter((scope) => !!scope && scope !== NO_ACCESS)
}

function inheritsAllViews(resource: string): boolean {
  return inheritedViewScopes(resource).includes('all')
}

function isZoneActive(resource: string, group: PresetActionGroup, value: string): boolean {
  return !(group.key === 'view' && inheritsAllViews(resource)) && groupScope(resource, group) === value
}

function isChipOn(resource: string, group: PresetActionGroup, value: string): boolean {
  if (group.key === 'view' && inheritsAllViews(resource)) return value === 'all'
  return scopeMoves(groupScope(resource, group) ?? '').includes(value)
}

/** Mixed existing rights stay unchanged until an administrator chooses a common scope. */
function onChipClick(resource: string, group: PresetActionGroup, value: string) {
  const scope = groupScope(resource, group)
  const next = scope === null || hasAdditionalScope(resource, scope) ? value : togglePresetScope(scope, value)
  for (const action of group.actions) {
    const key = cellKey(selected.value, resource, action)
    const eff = effective.value[key] ?? NO_ACCESS
    if (canon(next) === canon(eff)) delete staged[key]
    else staged[key] = next
  }
}

/** A cell holds a REAL change: its staged value differs from the effective
 *  one (an entry equal to the effective value is not a change). */
function isDirtyCell(preset: string, resource: string, action: string): boolean {
  const key = cellKey(preset, resource, action)
  return staged[key] !== undefined && staged[key] !== (effective.value[key] ?? NO_ACCESS)
}

/** Change descriptions for the save bar. */
const dirtyChanges = computed(() =>
  dirtyKeys.value.map((key) => {
    const [, resource, action] = key.split('|')
    const from = effective.value[key] ?? NO_ACCESS
    const to = staged[key]
    const label = `${actionTitle(action) || action} ${resourceLabel(resource) || resource}`
    return from !== NO_ACCESS
      ? `${label}: ${t('adminConfig.presets.changeLineFrom', { to: scopeLabel(resource, to), from: scopeLabel(resource, from) })}`
      : `${label}: ${scopeLabel(resource, to)}`
  }),
)

async function save() {
  const keys = dirtyKeys.value
  if (!keys.length || saving.value) return
  saving.value = true
  const failures: string[] = []
  for (const key of keys) {
    const [preset, resource, action] = key.split('|')
    const scope = staged[key]
    let ok: boolean
    if (scope === NO_ACCESS) {
      const id = ruleIdByCell.value[key]
      ok = id != null ? await rbac.deleteRule(id) : false
    } else {
      ok = await rbac.upsertRule({ preset, resource, action, scope })
    }
    if (!ok) {
      failures.push(`${preset} · ${actionTitle(action) || action} ${resourceLabel(resource) || resource}`)
    }
  }
  const reloaded = await rbac.reloadRules()
  saving.value = false
  if (reloaded) {
    for (const key of keys) {
      if (canon(staged[key]) === canon(effective.value[key] ?? NO_ACCESS)) delete staged[key]
    }
  }
  if (failures.length) {
    notifyError(t('adminConfig.presets.saveFailed', { list: failures.join('; ') }))
    return
  }
  if (!reloaded || keys.some((key) => staged[key] !== undefined)) {
    notifyError(t('adminConfig.presets.refreshFailed'))
    return
  }
  notifySuccess(t('adminConfig.presets.changesSaved'))
}

function cancelDirty() {
  for (const key of dirtyKeys.value) delete staged[key]
}

// Reset to defaults.
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()

// === Preset management (left panel) ===

/** Only the admin preset is immutable (a code invariant on the backend);
 *  every other preset — including the seeded dp/rp/vp/worker — can be
 *  deleted or renamed by an administrator. */
const BUILTIN_PRESETS = new Set(['admin'])

/** Preset name pattern: letters of any script (latin/cyrillic), digits, «-», «_»
 *  (mirrors the backend codec). */
const PRESET_TAG_RE = /^[\p{L}\p{N}_-]+$/u

/** Validates the create/rename form: tag (code) + display name. excludeTag —
 *  the rename target's own tag (collision with itself is allowed). */
function validatePresetForm(tag: string, name: string, excludeTag?: string): string | null {
  const trimmed = tag.trim()
  if (!trimmed) return t('adminConfig.presets.validationTagRequired')
  if (!PRESET_TAG_RE.test(trimmed)) return t('adminConfig.presets.validationTagFormat')
  if (excludeTag !== trimmed && rbac.presets.some((r) => r.tag === trimmed)) {
    return t('adminConfig.presets.validationTagDuplicate')
  }
  if (!name.trim()) return t('adminConfig.presets.validationNameRequired')
  return null
}

/* — create modal — */
const createOpen = ref(false)
const createForm = reactive({ tag: '', name: '', description: '' })
/** Local validation message (empty/invalid/duplicate tag, empty name);
 *  mutation errors are surfaced by the global toast (http.ts) instead. */
const createError = ref<string | null>(null)
const createBusy = ref(false)

async function onCreatePreset() {
  const tag = createForm.tag.trim()
  const name = createForm.name.trim()
  const localError = validatePresetForm(tag, name)
  if (localError) {
    createError.value = localError
    return
  }
  createBusy.value = true
  const ok = await rbac.createPreset({ tag, name, description: createForm.description.trim() })
  createBusy.value = false
  if (!ok) return
  notifySuccess(t('adminConfig.presets.created', { name }))
  createOpen.value = false
  selected.value = tag
  void rbac.loadRbac()
}

/* — rename modal (tag + name + description) — */
const renameOpen = ref(false)
const renameTarget = ref<string>('')
const renameForm = reactive({ tag: '', name: '', description: '' })
/** Local validation message; mutation errors — to the toast. */
const renameError = ref<string | null>(null)
const renameBusy = ref(false)

function openRename(presetTag: string) {
  if (BUILTIN_PRESETS.has(presetTag)) return
  const entry = presetEntry(presetTag)
  renameTarget.value = presetTag
  renameForm.tag = presetTag
  renameForm.name = entry?.name ?? ''
  renameForm.description = entry?.description ?? ''
  renameError.value = null
  renameOpen.value = true
}

async function onRenamePreset() {
  const tag = renameForm.tag.trim()
  const name = renameForm.name.trim()
  const localError = validatePresetForm(tag, name, renameTarget.value)
  if (localError) {
    renameError.value = localError
    return
  }
  renameBusy.value = true
  const ok = await rbac.updatePreset(renameTarget.value, {
    tag,
    name,
    description: renameForm.description.trim(),
  })
  renameBusy.value = false
  if (!ok) return
  notifySuccess(t('adminConfig.presets.renamed', { name }))
  renameOpen.value = false
  if (selected.value === renameTarget.value) selected.value = tag
  void rbac.loadRbac()
}

/* — delete modal (confirmation by typing the preset tag) — */
const deleteOpen = ref(false)
const deleteTarget = ref<string>('')
const deleteConfirm = ref('')
const deleteBusy = ref(false)

function openDelete(presetTag: string) {
  if (BUILTIN_PRESETS.has(presetTag)) return
  deleteTarget.value = presetTag
  deleteConfirm.value = ''
  deleteOpen.value = true
}

async function onDeletePreset() {
  if (deleteConfirm.value !== deleteTarget.value) return
  deleteBusy.value = true
  const ok = await rbac.deletePreset(deleteTarget.value)
  deleteBusy.value = false
  if (!ok) return
  notifySuccess(t('adminConfig.presets.deleted', { name: presetName(deleteTarget.value) }))
  deleteOpen.value = false
  if (selected.value === deleteTarget.value) {
    const rest = presetList.value.filter((p) => p !== deleteTarget.value)
    selected.value = rest[0] ?? ''
  }
  void rbac.loadRbac()
}

/* — context menu (ПКМ) — */
const ctxMenu = reactive({ open: false, x: 0, y: 0, preset: '' })

function onPresetContextMenu(e: MouseEvent, presetTag: string) {
  if (BUILTIN_PRESETS.has(presetTag)) return
  ctxMenu.open = true
  ctxMenu.x = e.clientX
  ctxMenu.y = e.clientY
  ctxMenu.preset = presetTag
}

function onCtxSelect(id: string) {
  const target = ctxMenu.preset
  ctxMenu.open = false
  if (id === 'rename') openRename(target)
  if (id === 'delete') openDelete(target)
}

function onReset() {
  ask(t('adminConfig.presets.resetConfirm'), () => {
    void (async () => {
      const ok = await rbac.resetRbac()
      if (ok) notifySuccess(t('adminConfig.presets.resetDone'))
      else notifyError(error.value ?? t('adminConfig.presets.resetFailed'))
    })()
  }, t('adminConfig.presets.resetButton'))
}

/** Select the default preset after the catalog is loaded. */
watch(presetList, (list) => {
  if ((!selected.value || !list.includes(selected.value)) && list.length) {
    selected.value = list[0]
  }
}, { immediate: true })

onMounted(() => {
  layoutMedia.addEventListener('change', syncColumnLayout)
  if (!presetRules.value.length && !loading.value) {
    void rbac.loadRbac()
  }
})
onBeforeUnmount(() => layoutMedia.removeEventListener('change', syncColumnLayout))
</script>

<template>
  <section class="pm">
    <div class="pm-head">
      <h2 class="pm-title">{{ t('adminConfig.presets.title') }}</h2>
      <HintButton hint="presets-editor" />
      <button type="button" class="pm-btn pm-reset" :disabled="saving || loading" @click="onReset">{{ t('adminConfig.presets.resetAll') }}</button>
    </div>

    <p v-if="loading && !presetRules.length" class="pm-load">{{ t('adminConfig.presets.loading') }}</p>
    <p v-if="error && !presetRules.length" class="pm-load er">{{ error }}</p>

    <div v-if="presetList.length" class="pm-layout">
      <!-- Roles -->
      <nav class="pm-presets" :aria-label="t('adminConfig.presets.roles')">
        <h3 class="pm-presets-title">{{ t('adminConfig.presets.roles') }}</h3>
        <div v-for="preset in presetList" :key="preset" class="pm-preset-item">
          <button
            type="button"
            class="pm-preset-btn"
            :class="{ active: preset === selected }"
            :aria-pressed="preset === selected"
            @click="selected = preset"
            @contextmenu.prevent="onPresetContextMenu($event, preset)"
          >
            <TooltipCell class="pm-preset-content" :multiline="true">
              <span class="pm-preset-code">{{ preset }}</span>
              <span class="pm-preset-name">{{ presetName(preset) }}</span>
              <template #popup>
                <InfoTooltip :title="presetName(preset)" :lines="presetTooltipLines(preset)" />
              </template>
            </TooltipCell>
          </button>
          <button
            v-if="!BUILTIN_PRESETS.has(preset)"
            type="button"
            class="pm-preset-remove"
            :class="{ active: preset === selected }"
            :aria-label="t('adminConfig.presets.removeTitle', { name: presetName(preset) })"
            :title="t('adminConfig.presets.removeTitle', { name: presetName(preset) })"
            @click="openDelete(preset)"
          ><AppIcon name="close" :size="14" /></button>
        </div>
        <button type="button" class="pm-preset-add" @click="createError = null; createOpen = true">
          {{ t('adminConfig.presets.add') }}
        </button>
        <ContextMenu
          :open="ctxMenu.open"
          :x="ctxMenu.x"
          :y="ctxMenu.y"
          :items="[
            { id: 'rename', label: t('adminConfig.presets.ctxRename') },
            { id: 'delete', label: t('adminConfig.presets.ctxDelete') },
          ]"
          @select="onCtxSelect"
          @close="ctxMenu.open = false"
        />
      </nav>

      <!-- Editor of the selected preset -->
      <div class="pm-editor">
        <div v-for="(column, columnIndex) in blockColumns" :key="columnIndex" class="pm-column">
          <div v-for="{ resource, group, index } in column" :key="resource" class="pm-block" :data-resource="resource" :data-order="index">
            <div class="pm-block-head">
              <h3 class="pm-block-title">{{ resourceTitle(resource) }}</h3>
              <span class="pm-block-group">{{ t(`adminConfig.perm.group.${group}`) }}</span>
            </div>
            <p v-if="resourceDescription(resource)" class="pm-resource-description">{{ resourceDescription(resource) }}</p>
            <div class="pm-actions" :class="{ 'pm-actions--administration': resource === 'administration' }">
              <div
                v-for="actionGroup in actionGroups(resource)"
                :key="actionGroup.key"
                class="pm-row"
                :data-action-group="actionGroup.key" :data-capability-resource="actionGroup.resource"
                :class="{ dirty: actionGroup.actions.some((action) => isDirtyCell(selected, actionGroup.resource, action)) }"
              >
                <div class="pm-action-head">
                  <span class="pm-row-label">{{ groupTitle(actionGroup) }}</span>
                  <span v-if="actionGroup.description" class="pm-action-hint">{{ t(`adminConfig.administration.description.${actionGroup.description}`) }}</span>
                  <span v-else-if="actionGroup.key === 'manage'" class="pm-action-hint">{{ t('adminConfig.presets.manageHint') }}</span>
                </div>
                <p v-if="actionGroup.key === 'view' && inheritedViewScopes(actionGroup.resource).length" class="pm-action-hint pm-inherited">
                  {{ t(inheritsAllViews(actionGroup.resource) ? 'adminConfig.presets.inheritedLocked' : 'adminConfig.presets.inheritedView') }}
                </p>
                <details v-if="groupScope(actionGroup.resource, actionGroup) === null" class="pm-mixed">
                  <summary>{{ t('adminConfig.presets.mixed') }}</summary>
                  <ul>
                    <li v-for="action in actionGroup.actions" :key="action">{{ actionTitle(action) }}: {{ scopeLabel(actionGroup.resource, cellValue(selected, actionGroup.resource, action)) }}</li>
                  </ul>
                  <p>{{ t('adminConfig.presets.mixedHint') }}</p>
                </details>
                <p v-if="groupScope(actionGroup.resource, actionGroup) && hasAdditionalScope(actionGroup.resource, groupScope(actionGroup.resource, actionGroup)!)" class="pm-action-hint">
                  {{ t('adminConfig.presets.savedCondition') }}: {{ scopeLabel(actionGroup.resource, groupScope(actionGroup.resource, actionGroup)!) }}
                </p>
                <TooltipCell
                  class="pm-choice-tooltip"
                  :text="t('adminConfig.presets.inheritedTooltip')"
                  :disabled="!(actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource))"
                  :tabindex="actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource) ? 0 : undefined"
                  :aria-label="actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource) ? t('adminConfig.presets.inheritedTooltip') : undefined"
                  multiline
                >
                <template #popup><span class="pm-inherited-tooltip">{{ t('adminConfig.presets.inheritedTooltip') }}</span></template>
                <div class="pm-chips" :class="{ 'pm-chips--inherited': actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource) }">
                  <button
                    v-for="opt in scopeChips(actionGroup.resource)"
                    :key="opt.value"
                    type="button"
                    class="pm-chip"
                    :disabled="actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource)"
                    :title="scopeOptionDescription(actionGroup.resource, opt.value)"
                    :class="{ on: isChipOn(actionGroup.resource, actionGroup, opt.value) }"
                    :aria-pressed="isChipOn(actionGroup.resource, actionGroup, opt.value)"
                    @click="onChipClick(actionGroup.resource, actionGroup, opt.value)"
                  >
                    {{ resource === 'administration' ? t('adminConfig.administration.allowed') : scopeLabel(actionGroup.resource, opt.value) }}
                  </button>
                  <button
                    type="button"
                    class="pm-chip rev"
                    :disabled="actionGroup.key === 'view' && inheritsAllViews(actionGroup.resource)"
                    :class="{ on: isZoneActive(actionGroup.resource, actionGroup, NO_ACCESS) }"
                    :aria-pressed="isZoneActive(actionGroup.resource, actionGroup, NO_ACCESS)"
                    :title="t('adminConfig.presets.revokeTitle')"
                    @click="onChipClick(actionGroup.resource, actionGroup, NO_ACCESS)"
                  >{{ t(actionGroup.key === 'view' && inheritedViewScopes(actionGroup.resource).length ? 'adminConfig.presets.onlyInherited' : 'adminConfig.presets.revokeChip') }}</button>
                </div>
                </TooltipCell>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Preset management modals: create / rename / delete (type the tag).
         Mutation failures are surfaced by the global toast (http.ts); the
         modal error line shows LOCAL validation only (empty/invalid/duplicate
         tag, empty name) — e.g. a cyrillic preset tag is valid and must be sent. -->
    <ModalForm
      :open="createOpen"
      :title="t('adminConfig.presets.createTitle')"
      :submit-label="t('adminConfig.presets.createSubmit')"
      :busy="createBusy"
      :error="createError"
      :fields="[
        { key: 'name', label: t('adminConfig.presets.fieldName'), type: 'text', required: true, placeholder: t('adminConfig.presets.fieldNamePlaceholder') },
        { key: 'tag', label: t('adminConfig.presets.fieldTag'), type: 'text', required: true, placeholder: t('adminConfig.presets.fieldTagPlaceholder') },
        { key: 'description', label: t('adminConfig.presets.fieldDescription'), type: 'textarea', placeholder: t('adminConfig.presets.fieldDescriptionPlaceholder') },
      ]"
      @save="(v: Record<string, string | number>) => { createForm.name = String(v.name ?? ''); createForm.tag = String(v.tag ?? ''); createForm.description = String(v.description ?? ''); void onCreatePreset() }"
      @close="createOpen = false"
    />

    <ModalForm
      :open="renameOpen"
      :title="t('adminConfig.presets.renameTitle')"
      :submit-label="t('adminConfig.presets.renameSubmit')"
      :busy="renameBusy"
      :error="renameError"
      :fields="[
        { key: 'name', label: t('adminConfig.presets.fieldName'), type: 'text', required: true, value: renameForm.name, placeholder: t('adminConfig.presets.renameNamePlaceholder') },
        { key: 'tag', label: t('adminConfig.presets.fieldTag'), type: 'text', required: true, value: renameForm.tag, placeholder: t('adminConfig.presets.renameTagPlaceholder') },
        { key: 'description', label: t('adminConfig.presets.fieldDescription'), type: 'textarea', value: renameForm.description, placeholder: t('adminConfig.presets.fieldDescriptionPlaceholder') },
      ]"
      @save="(v: Record<string, string | number>) => { renameForm.name = String(v.name ?? ''); renameForm.tag = String(v.tag ?? ''); renameForm.description = String(v.description ?? ''); void onRenamePreset() }"
      @close="renameOpen = false"
    />

    <!-- Удаление с подтверждением: нужно ввести тэг пресета -->
    <div v-if="deleteOpen" class="pm-del-overlay" @mousedown.self="deleteOpen = false">
      <div class="pm-del" role="dialog" aria-modal="true" :aria-label="t('adminConfig.presets.deleteAria')">
        <h3 class="pm-del-title">{{ t('adminConfig.presets.deleteTitle', { tag: deleteTarget }) }}</h3>
        <p class="pm-del-text">
          {{ t('adminConfig.presets.deleteText') }}
        </p>
        <input
          v-model="deleteConfirm"
          class="pm-del-input"
          :class="{ invalid: deleteConfirm !== '' && deleteConfirm !== deleteTarget }"
          :aria-invalid="deleteConfirm !== '' && deleteConfirm !== deleteTarget"
          :placeholder="deleteTarget"
        />
        <div class="pm-del-actions">
          <button type="button" class="pm-btn" @click="deleteOpen = false">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="pm-btn danger"
            :disabled="deleteConfirm !== deleteTarget || deleteBusy"
            @click="onDeletePreset"
          >
            {{ deleteBusy ? t('adminConfig.presets.deleting') : t('common.delete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Save bar -->
    <div v-if="dirtyKeys.length" class="pm-savebar">
      <div class="pm-savebar-info">
        <strong>{{ t('adminConfig.presets.changes', { count: dirtyKeys.length }) }}</strong>
        <ul>
          <li v-for="c in dirtyChanges" :key="c">{{ c }}</li>
        </ul>
      </div>
      <div class="pm-savebar-actions">
        <button type="button" class="pm-btn primary" :disabled="saving" @click="save">{{ saving ? t('adminConfig.presets.saving') : t('adminConfig.presets.save') }}</button>
        <button type="button" class="pm-btn" :disabled="saving" @click="cancelDirty">{{ t('adminConfig.presets.cancel') }}</button>
      </div>
    </div>

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
.pm-inherited-tooltip { white-space: pre-line; }
@import '../styles/tokens.css';

.pm-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 18px;
  flex-wrap: wrap;
}
.pm-head :deep(.hb) {
  border: 1px solid var(--ui-border-strong);
  background: var(--ui-surface);
  color: var(--ui-text-muted);
  font-weight: 500;
  box-shadow: none;
}
.pm-head :deep(.hb:hover),
.pm-head :deep(.hb[aria-expanded="true"]) {
  background: var(--ui-accent-soft);
  border-color: var(--ui-accent);
  color: var(--ui-accent);
  transform: none;
}
.pm-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
.pm-load {
  color: var(--ui-text-faint);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}
.pm-load.er {
  color: var(--ui-danger);
}
.pm-layout {
  display: grid;
  grid-template-columns: 200px minmax(0, 1fr);
  gap: 20px;
  align-items: start;
}
.pm-presets {
  display: flex;
  flex-direction: column;
  gap: 8px;
  position: sticky;
  top: 16px;
}
.pm-presets-title {
  margin: 0;
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.6px;
}
.pm-preset-item {
  position: relative;
  min-width: 0;
}
.pm-preset-btn {
  display: flex;
  align-items: center;
  width: 100%;
  min-width: 0;
  gap: 10px;
  text-align: left;
  padding: 11px 36px 11px 14px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  cursor: pointer;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text);
  transition: border-color var(--ui-duration), background var(--ui-duration);
}
.pm-preset-content {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  min-width: 0;
  flex: 1;
}
.pm-preset-remove {
  position: absolute;
  top: 11px;
  right: 8px;
  width: 22px;
  height: 22px;
  border: 0;
  background: transparent;
  border-radius: var(--ui-radius-sm);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
  opacity: 0.65;
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration), opacity var(--ui-duration);
}
.pm-preset-remove:hover,
.pm-preset-remove.active:hover {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
  opacity: 1;
}
.pm-preset-remove.active {
  color: var(--ui-accent);
}
/* Добавить пресет */
.pm-preset-add {
  display: block;
  width: 100%;
  padding: 9px 14px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  color: var(--ui-accent);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), border-color var(--ui-duration);
}
.pm-preset-add:hover {
  background: var(--ui-accent-soft);
  border-color: var(--ui-accent);
}
.pm-preset-btn:hover {
  border-color: var(--ui-border-strong);
  background: var(--ui-surface-3);
}
.pm-preset-btn.active {
  border-color: var(--ui-accent);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}
.pm-preset-btn.active .pm-preset-code,
.pm-preset-btn.active .pm-preset-name {
  color: var(--ui-accent);
}
.pm-preset-code {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 400;
  color: var(--ui-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.4px;
  overflow-wrap: anywhere;
}
.pm-preset-name {
  font-weight: 600;
  color: var(--ui-text);
  white-space: normal;
  overflow-wrap: anywhere;
}
.pm-editor {
  min-width: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  align-items: start;
}
/* Independent stacks avoid gaps from aligning cards of different heights. */
.pm-column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}
.pm-block-group {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  font-weight: 400;
  color: var(--ui-text-muted);
  margin: 0;
}
/* Resource card (Variant A design — same as the user-rights editor) */
.pm-block {
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  overflow: hidden;
  min-width: 0;
  box-shadow: var(--ui-shadow-sm);
}
.pm-block-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--ui-border);
}
.pm-block-title {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-text);
}
.pm-block-summary {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pm-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.pm-row {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  min-width: 0;
  gap: 8px;
  padding: 12px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  transition: background var(--ui-duration);
}
.pm-row + .pm-row { border-left: 1px solid var(--ui-border); }
.pm-row.dirty { background: var(--ui-warning-soft); }
.pm-row-label {
  color: var(--ui-text);
  font-weight: 500;
  overflow-wrap: anywhere;
}
.pm-chips {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 5px;
  min-width: 0;
}
.pm-row:nth-child(odd) { border-left: 0; }
.pm-row:nth-child(n + 3) { border-top: 1px solid var(--ui-border); }
.pm-action-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-height: 34px;
}
.pm-action-hint, .pm-mixed {
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
}
.pm-mixed {
  padding: 8px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface-2);
}
.pm-mixed summary { cursor: pointer; font-weight: 500; }
.pm-mixed ul { margin: 6px 0; padding-left: 16px; }
.pm-mixed p { margin: 6px 0 0; }
.pm-chip {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 6px 9px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-family: inherit;
  color: var(--ui-text-2);
  background: var(--ui-surface);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  white-space: normal;
  overflow-wrap: anywhere;
  max-width: 100%;
  text-align: left;
}
.pm-chip:not(:disabled):hover { border-color: var(--ui-accent); background: var(--ui-surface-2); }
.pm-chip.on {
  background: var(--ui-accent-soft);
  border-color: var(--ui-accent);
  color: var(--ui-accent);
  font-weight: 500;
}
.pm-reset { margin-left: auto; }
.pm-choice-tooltip { display: block; min-width: 0; }
.pm-inherited { margin: 0; line-height: 1.45; }
.pm-chips--inherited { cursor: not-allowed; }
.pm-chip:disabled {
  pointer-events: none;
  cursor: not-allowed;
  opacity: .55;
  color: var(--ui-text-muted);
  background: var(--ui-surface-2);
  border-color: var(--ui-border);
}
.pm-chip.on:disabled {
  opacity: .85;
  color: var(--ui-text-2);
  background: var(--ui-surface-3);
  border-color: var(--ui-border-strong);
}
.pm-expr-toggle {
  border: 1px solid var(--ui-border-strong);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
  background: var(--ui-surface);
  cursor: pointer;
}
.pm-expr-toggle:hover { border-color: var(--ui-accent); color: var(--ui-accent); }
/* Free-expression row under the chips */
.pm-expr-block {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 2px 0 2px 94px;
  flex-wrap: wrap;
}
.pm-expr {
  flex: 0 1 240px;
  min-width: 160px;
  font-family: ui-monospace, Menlo, Consolas, monospace;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  border: 1px solid var(--ui-border-strong);
  border-radius: 6px;
  padding: 4px 8px;
  color: var(--ui-text);
  background: var(--ui-surface);
}
.pm-expr.bad { border-color: var(--ui-danger); outline: 1px solid var(--ui-danger); }
.pm-expr-desc { font-size: calc(var(--ui-font-scale, 1) * 11px); color: var(--ui-text-2); }
.pm-expr-desc.bad { color: var(--ui-danger); }
.pm-expr-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 11px);
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 2px 5px;
  border-radius: 5px;
}
.pm-expr-close:hover { background: var(--ui-surface-2); color: var(--ui-text); }

@media (max-width: 1000px) {
  .pm-layout { grid-template-columns: minmax(0, 1fr); }
  .pm-presets {
    position: static;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  }
  .pm-presets-title { grid-column: 1 / -1; }
}
@media (max-width: 720px) {
  .pm-editor { grid-template-columns: minmax(0, 1fr); }
  .pm-savebar { flex-wrap: wrap; }
  .pm-savebar-actions { flex-wrap: wrap; }
}

.pm-savebar {
  position: sticky;
  bottom: 12px;
  margin-top: 18px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-sm);
  padding: 12px 16px;
  display: flex;
  gap: 18px;
  align-items: flex-start;
  z-index: 10;
}
.pm-savebar-info {
  flex: 1;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text);
}
.pm-savebar-info ul {
  margin: 6px 0 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.pm-savebar-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}
.pm-btn {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 500;
  border: 1px solid var(--ui-border-strong);
  background: var(--ui-surface);
  color: var(--ui-text);
  border-radius: var(--ui-radius-sm);
  padding: 7px 14px;
  cursor: pointer;
  transition: background var(--ui-duration), border-color var(--ui-duration);
}
.pm-btn:hover:not(:disabled) {
  background: var(--ui-surface-3);
}
.pm-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.pm-btn.primary {
  background: var(--ui-accent);
  border-color: var(--ui-accent);
  color: var(--ui-accent-on);
}
.pm-btn.primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
  border-color: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.pm-btn.danger {
  color: var(--ui-danger);
  border-color: color-mix(in srgb, var(--ui-danger) 45%, transparent);
}
.pm-btn.danger:hover:not(:disabled) {
  background: var(--ui-danger-soft);
}
.pm-save-msg {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-success);
  margin: 12px 0;
}
.pm-save-msg.er {
  color: var(--ui-danger);
}

/* Удаление пресета — модалка с подтверждением (ввод имени) */
.pm-del-overlay {
  position: fixed;
  inset: 0;
  z-index: 40001;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  padding: 16px;
}
.pm-del {
  width: 100%;
  max-width: 420px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-md);
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pm-del-title {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: var(--ui-text);
}
.pm-del-text {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  line-height: 1.5;
  color: var(--ui-text-2);
}
.pm-del-input {
  font-family: inherit;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 8px 10px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  color: var(--ui-text);
}
.pm-del-input.invalid {
  border-color: var(--ui-danger);
  outline: 1px solid var(--ui-danger);
}
.pm-del-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.pm-actions--administration { display: flex; flex-direction: column; }
.pm-actions--administration > div + div { border-left: 0; border-top: 1px solid var(--ui-border); }
.pm-actions--administration .pm-chips { flex-direction: row; flex-wrap: wrap; }
.pm-resource-description { margin: 0; padding: 10px 14px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 11px); line-height: 1.5; border-bottom: 1px solid var(--ui-border); }
</style>
