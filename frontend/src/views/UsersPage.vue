<script setup lang="ts">
import { usePageReadRefresh } from '@/composables/usePageReadRefresh'
usePageReadRefresh(async () => { await app.loadAdminUsers() })
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'
import { HintButton, ContextMenu, ConfirmDialog, DataTable } from '../components/common'
import type { DataTableColumn } from '../components/common'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import { useConfirm } from '../composables/useConfirm'
import { useContextMenu } from '../composables/useContextMenu'
import { useAppStore, useRbacStore } from '../store'
import { useColumnWidths } from '../composables/useColumnWidths'
import { presetDisplayName, presetDescriptionByTag, presetLabelFromCatalog } from '../utils/presets'
import { t } from '../i18n'
import type { DtoAdminUserResponse } from '@/api'

const router = useRouter()
const app = useAppStore()
const rbac = useRbacStore()
const { adminUsers, adminUsersLoading, adminUsersError } = storeToRefs(app)
const { presets } = storeToRefs(rbac)

/**
 * The DataTable cell slot gives the row as `unknown` (generic inference does
 * not reach through the store's refs) — cast to the page's row type here.
 */
const asUser = (row: unknown): DtoAdminUserResponse => row as DtoAdminUserResponse

/** Table columns: sortable keys; sorting itself lives inside DataTable. */
const columns = computed<DataTableColumn[]>(() => [
  { key: 'name', label: t('adminUsers.users.column.name'), width: 'fit-content(380px)' },
  { key: 'username', label: t('adminUsers.users.column.login'), width: 'fit-content(280px)' },
  { key: 'preset', label: t('adminUsers.users.column.preset'), width: 'fit-content(260px)' },
])

/** Display name of a preset by its tag: looked up in the catalog (name wins),
 *  falling back to the built-in label, then to the raw tag. */
function presetLabel(preset?: string): string {
  return presetLabelFromCatalog(preset, presets.value)
}

/** Native tooltip of the "Preset" cell: the preset description, else its name. */
function presetHint(preset?: string): string {
  return presetDescriptionByTag(preset, presets.value) || presetLabel(preset)
}

/** Preset filter: '' — all, otherwise the preset tag */
const fPreset = ref('')

/** Preset filter options: the whole catalog (built-in + custom). */
const presetFilterOptions = computed(() => presets.value.map((p) => ({ value: p.tag ?? '', label: presetDisplayName(p) })))
const fName = ref('')
const fLogin = ref('')

/** Client-side filtering (sorting is delegated to DataTable) */
const filteredUsers = computed(() => {
  const qName = fName.value.trim().toLowerCase()
  const qLogin = fLogin.value.trim().toLowerCase()
  const preset = fPreset.value
  return adminUsers.value.filter((u) => {
    if (qName && !(u.name ?? '').toLowerCase().includes(qName)) return false
    if (qLogin && !(u.username ?? '').toLowerCase().includes(qLogin)) return false
    if (preset && u.preset !== preset) return false
    return true
  })
})

const emptyText = computed(() =>
  adminUsers.value.length ? t('adminUsers.users.emptyFound') : t('common.noData'),
)

/** Per-user persisted column widths (drag-resize on the header edges). */
const { columnWidths } = useColumnWidths('users')

/**
 * Row actions (context menu), gated by the user-admin rights: editing a user
 * (who is also an employee) happens only in this admin section and only with
 * the user.edit permission.
 */
interface RowMenuState {
  x: number
  y: number
  userId: number
}
const menu = ref<RowMenuState | null>(null)

const menuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = []
  if (rbac.can('user_admin', 'update')) {
    items.push({ id: 'edit-user', label: t('adminUsers.users.action.edit') })
  }
  if (rbac.can('user_admin', 'delete')) {
    items.push({ id: 'delete-user', label: t('adminUsers.users.action.delete') })
  }
  return items
})

function onRowContextMenu(e: MouseEvent, u: DtoAdminUserResponse) {
  if (u.id == null || !menuItems.value.length) return
  openMenu({ x: e.clientX, y: e.clientY, userId: u.id })
}

const { open: openMenu, close: closeMenu, select, bind: menuBind } = useContextMenu(menu, menuItems, handleSelect)

function handleSelect(id: string) {
  if (!menu.value || !menuItems.value.some((item) => item.id === id)) return
  const u = adminUsers.value.find((x) => x.id === menu.value?.userId)
  if (!u) return
  if (id === 'edit-user') {
    goToEdit(u)
  } else if (id === 'delete-user') askDelete(u)
}

// === Deleting a user (soft delete; lifecycle lives in this admin section) ===
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()
const deleteTarget = ref<string | null>(null)

function askDelete(u: DtoAdminUserResponse) {
  deleteTarget.value = u.id != null ? String(u.id) : null
  ask(t('adminUsers.users.confirmDelete', { name: u.name ?? u.username ?? '' }), async () => {
    const id = Number(deleteTarget.value)
    if (!Number.isFinite(id) || id <= 0) return
    deleteTarget.value = null
    const ok = await app.deleteUser(id)
    if (ok) {
      await refreshAfterMutation()
    }
    // Failed deletions (e.g. blocked by referencing records) are surfaced by
    // the global error notification (http.ts interceptor) — no local banner.
  })
}

/** Row click → the user's edit page (users/:id/edit); requires the user.edit right */
function goToEdit(u: DtoAdminUserResponse) {
  if (u.id == null || !rbac.can('user_admin', 'update')) return
  void router.push(`/users/${u.id}/edit`)
}

onMounted(() => {
  void app.loadAdminUsers()
})

/** Reloads the admin list after a mutation (delete) */
async function refreshAfterMutation() {
  await app.refreshAdminUsers('')
}
</script>

<template>
  <section class="up">
    <p v-if="adminUsersLoading && !adminUsers.length" class="up-st">{{ t('common.loading') }}</p>
    <p v-if="adminUsersError && !adminUsers.length" class="up-st er">{{ adminUsersError }}</p>

    <!--
      The table frame (header and the filter row) stays visible even when the
      filters leave no rows: the empty-state message is rendered inside the
      table instead of replacing it, so the filters remain editable.
    -->
    <DataTable
      v-if="adminUsers.length || (!adminUsersLoading && !adminUsersError)"
      :columns="columns"
      :rows="filteredUsers"
      :title="t('adminUsers.users.title')"
      :empty-text="emptyText"
      resizable
      v-model:column-widths="columnWidths"
      @row-click="(_e, row) => goToEdit(asUser(row))"
      @row-contextmenu="(e, row) => onRowContextMenu(e, asUser(row))"
    >
      <template #actions>
        <HintButton hint="users" />
        <button v-if="rbac.can('user_admin', 'create')" type="button" class="up-add" @click="router.push('/users/new')">
          {{ t('adminUsers.users.create') }}
        </button>
      </template>
      <template #filter="{ column }">
        <input v-if="column.key === 'name'" v-model="fName" type="search" class="th-filter" :placeholder="t('adminUsers.users.filter.namePlaceholder')" />
        <input v-else-if="column.key === 'username'" v-model="fLogin" type="search" class="th-filter" :placeholder="t('adminUsers.users.filter.loginPlaceholder')" />
        <select v-else-if="column.key === 'preset'" v-model="fPreset" class="th-filter">
          <option value="">{{ t('adminUsers.users.filter.allPresets') }}</option>
          <option v-for="opt in presetFilterOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </template>
      <template #cell="{ row, column }">
        <span v-if="column.key === 'name'" class="up-name">{{ asUser(row).name }}</span>
        <span v-else-if="column.key === 'username'" class="mono">{{ asUser(row).username }}</span>
        <span v-else class="up-preset" :title="presetHint(asUser(row).preset)">{{ presetLabel(asUser(row).preset) }}</span>
      </template>
    </DataTable>

    <ContextMenu v-bind="menuBind" @select="select" @close="closeMenu" />

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

/* Toolbar controls (rendered inside the DataTable actions slot) */
.up-add {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  transition: background var(--ui-duration), opacity var(--ui-duration);
}
.up-add:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.up-add:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
/* Loading / error placeholders outside the table */
.up-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}
.up-name {
  font-weight: 700;
  color: var(--ui-text);
}
.up-preset {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}
</style>