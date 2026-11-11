<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ContextMenu, ModalForm, ConfirmDialog, PendingMark, DataTable } from '../components/common'
import type { DataTableColumn } from '../components/common'
import type { ContextMenuItem } from '../components/common/ContextMenu'
import type { ModalField } from '../components/common/ModalForm'
import { useConfirm } from '../composables/useConfirm'
import { useContextMenu } from '../composables/useContextMenu'
import { useEditModal } from '../composables/useEditModal'
import { useRoleAccess } from '../composables/useRoleAccess'
import { useColumnWidths } from '../composables/useColumnWidths'
import { useTimesheetStore } from '../store'
import { isOffline } from '../offline/state'
import { scheduleNamedRefresh } from '../offline/sync'
import { t } from '@/i18n'
import type { DtoStateResponse } from '@/api'

const ts = useTimesheetStore()
const { states, loading, error } = storeToRefs(ts)

/**
 * The DataTable cell slot gives the row as `unknown` (generic inference does
 * not reach through the store's refs) — cast to the page's row type here.
 */
const asState = (row: unknown): DtoStateResponse => row as DtoStateResponse

// Column config for the DataTable: content-sized tracks with a hard cap
// (long values wrap instead of shifting the following columns); the
// component itself appends the 1fr spacer that stretches the bands.
const columns = computed<DataTableColumn[]>(() => [
  { key: 'code', label: t('adminConfig.statuses.colCode'), width: '140px' },
  { key: 'name', label: t('adminConfig.statuses.colName'), width: 'fit-content(420px)' },
  { key: 'is_available', label: t('adminConfig.statuses.colAvailable'), width: '160px' },
])

/** Per-user persisted column widths (drag-resize on the header edges). */
const { columnWidths } = useColumnWidths('statuses')

// The page is available to vp/admin only (route + guard); the buttons follow
// the exact backend rights: create/update/delete are separate state.* rules.
const { canCreateState, canManageState, canDeleteState } = useRoleAccess()

// Right-click on a row: edit/delete
interface MenuState {
  x: number
  y: number
  stateId: number
}
const menu = ref<MenuState | null>(null)
const menuItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = []
  if (canManageState.value) items.push({ id: 'edit-state', label: t('adminConfig.statuses.editMenu') })
  if (canDeleteState.value) items.push({ id: 'delete-state', label: t('adminConfig.statuses.deleteMenu') })
  return items
})

// Delete confirmation dialog
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()

type ModalMode =
  | { type: 'create' }
  | { type: 'edit'; id: number; code: string; name: string; isAvailable: boolean; color: string }

/** Status availability (ModalField does not support boolean — we use '1'/'0') */
const availabilityOptions = computed<ModalField['options']>(() => [
  { value: '1', label: t('adminConfig.statuses.available') },
  { value: '0', label: t('adminConfig.statuses.unavailable') },
])

const { open: openModal, close: closeModal, submit: submitModal, bind: modalBind } = useEditModal<ModalMode>(
  (state) => [
    { key: 'code', label: t('adminConfig.statuses.fieldCode'), type: 'text', value: state.type === 'edit' ? state.code : '', required: true },
    { key: 'name', label: t('adminConfig.statuses.fieldName'), type: 'text', value: state.type === 'edit' ? state.name : '', required: true },
    {
      key: 'color',
      label: t('adminConfig.statuses.fieldColor'),
      type: 'color',
      value: state.type === 'edit' ? state.color ?? '' : '',
    },
    {
      key: 'isAvailable',
      label: t('adminConfig.statuses.fieldAvailable'),
      type: 'select',
      options: availabilityOptions.value,
      value: state.type === 'edit' ? (state.isAvailable ? '1' : '0') : '1',
    },
  ],
  async (state, values) => {
    const payload = {
      code: String(values.code ?? '').trim(),
      name: String(values.name ?? '').trim(),
      is_available: values.isAvailable === '1',
      // '' means "no custom color" — the backend stores NULL (palette fallback).
      color: String(values.color ?? ''),
    }
    const ok =
      state.type === 'create'
        ? await ts.createState(payload)
        : await ts.updateState(state.id, payload)
    return { ok, error: ok ? null : error.value }
  },
  (state) => (state.type === 'create' ? t('adminConfig.statuses.create') : t('adminConfig.statuses.editTitle')),
  (state) => (state.type === 'create' ? t('common.create') : t('adminConfig.statuses.save')),
  (state) => state.type === 'create' ? canCreateState.value : canManageState.value,
)

function onRowContextMenu(e: MouseEvent, st: DtoStateResponse) {
  if (st.id == null || (!canManageState.value && !canDeleteState.value)) return
  openMenu({ x: e.clientX, y: e.clientY, stateId: st.id })
}

const { open: openMenu, close: closeMenu, select, bind: menuBind } = useContextMenu(menu, menuItems, handleSelect)

function openCreate() {
  openModal({ type: 'create' })
}

function openEdit(id: number) {
  const st = states.value.find((s) => s.id === id)
  if (st) {
    openModal({
      type: 'edit',
      id,
      code: st.code ?? '',
      name: st.name ?? '',
      isAvailable: st.is_available ?? true,
      color: st.color ?? '',
    })
  }
}

function handleSelect(id: string) {
  if (!menu.value || !menuItems.value.some((item) => item.id === id)) return
  if (id === 'edit-state') {
    openEdit(menu.value.stateId)
  } else if (id === 'delete-state') {
    const stateId = menu.value.stateId
    ask(t('adminConfig.statuses.confirmDelete'), () => {
      void ts.deleteState(stateId)
    })
  }
}

onMounted(() => {
  if (!states.value.length) void ts.loadStates()
  if (!isOffline.value) scheduleNamedRefresh(['states'])
})
</script>

<template>
  <section class="sp">
    <p v-if="loading && !states.length" class="sp-st">{{ t('adminConfig.statuses.loading') }}</p>
    <p v-if="error && !states.length" class="sp-st er">{{ error }}</p>

    <!--
      The table frame (header included) stays visible even when there is no
      data: the empty-state message is rendered inside the table instead of
      replacing it.
    -->
    <DataTable
      v-if="states.length || (!loading && !error)"
      :columns="columns"
      :rows="states"
      :title="t('adminConfig.statuses.title')"
      :empty-text="t('adminConfig.statuses.empty')"
      resizable
      v-model:column-widths="columnWidths"
      @row-contextmenu="onRowContextMenu"
    >
      <template #actions>
        <button v-if="canCreateState" type="button" class="tbar-add" @click="openCreate">{{ t('adminConfig.statuses.create') }}</button>
      </template>
      <template #cell="{ row, column }">
        <span v-if="column.key === 'code'" class="code">
          <span v-if="asState(row).color" class="swatch" :style="{ background: asState(row).color }" aria-hidden="true"></span>
          {{ asState(row).code }}
          <PendingMark entity="state" :id="asState(row).id" />
        </span>
        <span v-else-if="column.key === 'is_available'" class="avail" :class="{ off: !asState(row).is_available }">
          {{ asState(row).is_available ? t('adminConfig.statuses.available') : t('adminConfig.statuses.unavailable') }}
        </span>
        <template v-else>{{ asState(row).name }}</template>
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

    <ModalForm v-bind="modalBind" @save="submitModal" @close="closeModal" />
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

/* "Create status" button — sits in the DataTable toolbar actions slot. */
.tbar-add {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  transition: background var(--ui-duration);
}
.tbar-add:hover {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
/* Loading / error placeholders outside the table */
.sp-st {
  color: var(--ui-text-muted);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.er { color: var(--ui-danger); }

/* Status code cell: swatch + code + pending mark */
.code {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-weight: 700;
  color: var(--ui-accent);
}
/* Borderless custom-color swatch next to the state code (only when a color is set) */
.swatch {
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  display: inline-block;
}
/* Availability badge */
.avail {
  display: inline-block;
  padding: 2px 10px;
  border-radius: 10px;
  background: var(--ui-success-soft);
  color: var(--ui-success);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
}
.avail.off {
  background: var(--ui-danger-soft);
  color: var(--ui-danger);
}
</style>
