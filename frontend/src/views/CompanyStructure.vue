<script setup lang="ts">
import { usePageReadRefresh } from '@/composables/usePageReadRefresh'
usePageReadRefresh(async () => { if (managerEditing.value != null || saving.value) return false; await loadStructure() })
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { DataTable, HintButton } from '../components/common'
import type { DataTableColumn } from '../components/common'
import { useAppStore, useAuthStore, useRbacStore, apiConfig } from '../store'
import { OrgChart } from '../components/common/OrgChart'
import { buildOrgForest } from '../components/common/OrgChart/layout'
import { isReadCancelled } from '@/store/data/apiReads'
import { loadStructure as readStructure } from '@/store/data/pageReads'
import { apiErrorMessage } from '../utils'
import { useColumnWidths } from '../composables/useColumnWidths'
import { presetDescriptionByTag, presetLabelFromCatalog } from '../utils/presets'
import { t } from '../i18n'
import type { DtoAdminUserResponse } from '@/api'

const app = useAppStore()
const rbac = useRbacStore()
const auth = useAuthStore()
const adminUsers = ref<DtoAdminUserResponse[]>([])
const adminUsersLoading = ref(false)
const adminUsersError = ref('')
const forest = computed(() => buildOrgForest(adminUsers.value))
const stateKey = computed(() => `mvs_erp_structure_${auth.user?.id ?? 'anonymous'}`)
const representation = ref<'chart' | 'table'>('chart')
const page = ref(0)
const pageSize = 100
const managerEditing = ref<number | null>(null)
const abort = new AbortController()
const canEdit = computed(() => rbac.can('user_admin', 'update'))

async function loadStructure() {
  adminUsersLoading.value = true
  adminUsersError.value = ''
  try {
    const response = await readStructure(apiConfig, abort.signal)
    const all = response.data?.data ?? []
    if (!abort.signal.aborted) adminUsers.value = all
  } catch (error: unknown) {
    if (!abort.signal.aborted && !isReadCancelled(error)) {
      const payload = (error as { response?: { data?: { error?: { message?: string; code?: unknown } } } } | null)?.response?.data?.error
      adminUsersError.value = apiErrorMessage(payload, error instanceof Error ? error.message : t('adminUsers.structure.loadIncomplete'))
    }
  } finally {
    adminUsersLoading.value = false
  }
}
watch(representation, (value) => {
  try { sessionStorage.setItem(`${stateKey.value}_view`, value) } catch { /* Optional per-session preference. */ }
})

const { presets } = storeToRefs(rbac)

function presetLabel(preset?: string | null): string {
  return presetLabelFromCatalog(preset, presets.value)
}

/** Native tooltip of the "Preset" cell: the preset description, else its name. */
function presetHint(preset?: string | null): string {
  return presetDescriptionByTag(preset, presets.value) || presetLabel(preset)
}

interface TreeNode {
  user: DtoAdminUserResponse
  depth: number
  childrenCount: number
}
const tree = computed<TreeNode[]>(() => forest.value.order.map((node) => ({ user: node.user, depth: node.depth, childrenCount: node.descendants })))
const tableRows = computed(() => tree.value.slice(page.value * pageSize, (page.value + 1) * pageSize))
watch(tree, () => { page.value = Math.min(page.value, Math.max(0, Math.ceil(tree.value.length / pageSize) - 1)) })

/**
 * The DataTable cell slot gives the row as `unknown` — cast to the page's
 * node type here.
 */
const asNode = (row: unknown): TreeNode => row as TreeNode

/** Column config; sorting is intentionally off — the tree keeps its order. */
const columns = computed<DataTableColumn[]>(() => [
  { key: 'name', label: t('adminUsers.structure.column.employee'), width: 'fit-content(420px)', sortable: false },
  { key: 'role', label: t('adminUsers.structure.column.role'), width: 'fit-content(240px)', sortable: false },
  { key: 'manager', label: t('adminUsers.structure.column.manager'), width: 'fit-content(280px)', sortable: false },
  { key: 'children', label: t('adminUsers.structure.column.subordinates'), width: '120px', sortable: false },
])

/** Per-user persisted column widths (drag-resize on the header edges). */
const { columnWidths } = useColumnWidths('structure')

/** All direct and indirect descendants of a user (cycle-safe) */
function descendantsOf(id: number): Set<number> {
  const out = new Set<number>()
  const stack = [...(forest.value.nodes.get(id)?.children ?? [])]
  while (stack.length) {
    const next = stack.pop()!
    if (out.has(next)) continue
    out.add(next)
    stack.push(...(forest.value.nodes.get(next)?.children ?? []))
  }
  return out
}

const saving = ref(false)

/** Manager options: all users except the user itself and its descendants, sorted by name */
function managerOptions(user: DtoAdminUserResponse) {
  const excluded = user.id != null ? descendantsOf(user.id) : new Set<number>()
  if (user.id != null) excluded.add(user.id)
  return [
    { value: '', label: t('adminUsers.structure.noManager') },
    ...adminUsers.value
      .filter((u) => u.id != null && !excluded.has(u.id))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
      .map((u) => ({ value: u.id as number, label: u.name ?? `#${u.id}` })),
  ]
}

async function onChangeManager(user: DtoAdminUserResponse, event: Event) {
  const raw = (event.target as HTMLSelectElement).value
  if (user.id == null) return
  const managerId = raw === '' ? null : Number(raw)
  if ((managerId ?? null) === (user.manager_id ?? null)) return
  saving.value = true
  // A failed change is reported by the global toast (http.ts).
  try {
    if (await app.updateManager(user.id, managerId)) await loadStructure()
  } finally {
    saving.value = false
    managerEditing.value = null
  }
}

async function editManager(id: number) {
  if (!canEdit.value) return
  managerEditing.value = id
  await nextTick()
  document.querySelector<HTMLSelectElement>(`select[data-manager-id="${id}"]`)?.focus()
}

onMounted(() => {
  try { representation.value = sessionStorage.getItem(`${stateKey.value}_view`) === 'table' ? 'table' : 'chart' } catch { /* Start with the chart when storage is unavailable. */ }
  void loadStructure()
  void rbac.ensurePresets()
})
onBeforeUnmount(() => abort.abort())

</script>

<template>
  <section class="cs">
    <header class="cs-header">
      <h2>{{ t('adminUsers.structure.title') }}</h2>
      <div class="cs-switch" role="group" :aria-label="t('adminUsers.structure.representation')">
        <button type="button" :aria-pressed="representation === 'chart'" @click="representation = 'chart'">{{ t('adminUsers.structure.chart') }}</button>
        <button type="button" :aria-pressed="representation === 'table'" @click="representation = 'table'">{{ t('adminUsers.structure.table') }}</button>
        <HintButton hint="structure" />
      </div>
    </header>
    <OrgChart v-if="representation === 'chart' && (!adminUsersLoading || adminUsers.length) && (!adminUsersError || adminUsers.length)" :employees="adminUsers" :presets="presets" :state-key="stateKey" />
    <p v-if="adminUsersLoading && !tree.length" class="cs-st">{{ t('common.loading') }}</p>
    <p v-if="adminUsersError" class="cs-st er">{{ adminUsersError }} <button type="button" class="cs-retry" :disabled="adminUsersLoading" @click="loadStructure">{{ t('adminUsers.structure.retry') }}</button></p>

    <!--
      The table frame (header included) stays visible even when there is no
      data: the empty-state message is rendered inside the table instead of
      replacing it.
    -->
    <DataTable
      v-if="representation === 'table' && (tree.length || (!adminUsersLoading && !adminUsersError))"
      :columns="columns"
      :rows="tableRows"
      :title="t('adminUsers.structure.table')"
      :empty-text="t('common.noData')"
      resizable
      v-model:column-widths="columnWidths"
    >
      <template #actions>
        <HintButton hint="structure" />
      </template>
      <template #cell="{ row, column }">
        <span v-if="column.key === 'name'" class="cs-name" :style="{ paddingLeft: Math.min(asNode(row).depth, 12) * 22 + 'px' }">
          <span class="depth-tick" v-if="asNode(row).depth > 0">↳</span>
          <span class="name">{{ asNode(row).user.name }}</span>
          <span class="mono">{{ asNode(row).user.username }}</span>
        </span>
        <template v-else-if="column.key === 'role'"><span :title="presetHint(asNode(row).user.preset)">{{ presetLabel(asNode(row).user.preset) }}</span></template>
        <span v-else-if="column.key === 'manager'" class="cs-mgr-wrap">
          <button v-if="managerEditing !== asNode(row).user.id" type="button" class="cs-manager-open" :disabled="!canEdit || saving" :title="t('adminUsers.structure.changeManager')" @click="editManager(asNode(row).user.id!)">{{ adminUsers.find((user) => user.id === asNode(row).user.manager_id)?.name || t('adminUsers.structure.noManager') }}</button>
          <select
            v-else
            :data-manager-id="asNode(row).user.id"
            :aria-label="t('adminUsers.structure.column.manager')"
            class="cs-mgr"
            :value="asNode(row).user.manager_id ?? ''"
            :disabled="saving || !canEdit"
            @change="onChangeManager(asNode(row).user, $event)"
            @blur="managerEditing = null"
          >
            <option v-for="opt in managerOptions(asNode(row).user)" :key="String(opt.value)" :value="opt.value">{{ opt.label }}</option>
          </select>
        </span>
        <template v-else>{{ asNode(row).childrenCount }}</template>
      </template>
    </DataTable>
    <div v-if="representation === 'table' && tree.length > pageSize" class="cs-pagination">
      <button type="button" :disabled="page === 0" @click="page--">{{ t('adminUsers.structure.previousPage') }}</button>
      <span>{{ t('adminUsers.structure.page', { page: page + 1, total: Math.ceil(tree.length / pageSize) }) }}</span>
      <button type="button" :disabled="(page + 1) * pageSize >= tree.length" @click="page++">{{ t('adminUsers.structure.nextPage') }}</button>
    </div>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

/* Loading / error placeholders outside the table */
.cs-st {
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-faint);
  margin-left: 8px;
}

/* Cell renders */
.cs-name {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
}
.name {
  font-weight: 700;
  color: var(--ui-accent);
}
.depth-tick {
  color: var(--ui-text-faint);
  margin-right: 6px;
}
.cs-mgr-wrap {
  display: block;
}
.cs-mgr {
  box-sizing: border-box;
  width: 100%;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  padding: 6px 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-family: inherit;
  color: var(--ui-text);
  background: var(--ui-surface);
  outline: none;
}
.cs-mgr:focus {
  border-color: var(--ui-accent);
}

.cs-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 20px; }
.cs-header h2 { font-size: calc(var(--ui-font-scale, 1) * 24px); color: var(--ui-text); margin: 0; }
.cs-switch { display: flex; align-items: center; gap: 8px; }
.cs-switch button, .cs-pagination button { font: inherit; font-size: calc(var(--ui-font-scale, 1) * 13px); padding: 9px 14px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); color: var(--ui-text); background: var(--ui-surface); cursor: pointer; }
.cs-switch button[aria-pressed=true] { color: var(--ui-accent); background: var(--ui-accent-soft); border-color: var(--ui-accent); }
.cs-pagination { display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap; padding: 16px; font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-muted); }
.cs-pagination button:disabled { opacity: .5; cursor: default; }
.cs-manager-open { border: 0; background: transparent; color: var(--ui-text); padding: 6px 0; text-align: left; font: inherit; cursor: pointer; }
.cs-manager-open:disabled { cursor: default; }
.cs-retry { margin-left: 12px; font: inherit; color: var(--ui-accent); border: 0; background: transparent; text-decoration: underline; cursor: pointer; }
</style>
