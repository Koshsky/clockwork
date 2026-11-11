<script setup lang="ts">
import { computed } from 'vue'
import type { DtoAdminUserResponse } from '@/api'
import { t } from '../../../i18n'
import { fullName } from '../../../utils/fullName'
import { shortName } from '../../../utils/shortName'
import { TEAM_PAGE_SIZE, TEAM_PREVIEW_SIZE } from './layout'

const props = withDefaults(defineProps<{
  members: DtoAdminUserResponse[]
  page?: number
  selectedId?: number | null
  groupName: string
  label?: string
}>(), { page: -1, selectedId: null, label: '' })
const emit = defineEmits<{ 'update:page': [page: number]; select: [id: number] }>()
const expanded = computed(() => props.page >= 0 && props.members.length > TEAM_PREVIEW_SIZE)
const currentPage = computed(() => Math.min(Math.max(0, props.page), Math.max(0, Math.ceil(props.members.length / TEAM_PAGE_SIZE) - 1)))
const start = computed(() => expanded.value ? currentPage.value * TEAM_PAGE_SIZE : 0)
const visible = computed(() => props.members.slice(start.value, start.value + (expanded.value ? TEAM_PAGE_SIZE : TEAM_PREVIEW_SIZE)))
const displayName = (user: DtoAdminUserResponse) => fullName(user).trim() || user.name || user.username || `#${user.id}`
const compactName = (user: DtoAdminUserResponse) => shortName(user) || displayName(user)
</script>

<template>
  <div v-if="members.length" class="ot" :class="{ expanded }" :aria-label="groupName">
    <div class="ot-heading"><span>{{ label || t('adminUsers.structure.staff') }}</span><span class="ot-count">{{ members.length }}</span></div>
    <ul class="ot-list" :style="{ minHeight: expanded ? `${Math.min(members.length, TEAM_PAGE_SIZE) * 32}px` : undefined }">
      <li v-for="member in visible" :key="member.id">
        <button
          type="button" class="ot-person" :aria-pressed="selectedId === member.id" :title="[displayName(member), member.position].filter(Boolean).join(' · ')"
          :aria-label="displayName(member)" @click="member.id != null && emit('select', member.id)"
        ><span class="ot-dot" aria-hidden="true"></span><span class="ot-name">{{ compactName(member) }}</span></button>
      </li>
    </ul>
    <template v-if="expanded">
      <div class="ot-pagination" role="group" :aria-label="t('adminUsers.structure.staffPages', { name: groupName })">
        <button type="button" :disabled="currentPage === 0" :aria-label="t('adminUsers.structure.previousStaff', { name: groupName })" @click="emit('update:page', currentPage - 1)">‹</button>
        <span aria-live="polite">{{ t('adminUsers.structure.staffRange', { from: start + 1, to: Math.min(start + TEAM_PAGE_SIZE, members.length), total: members.length }) }}</span>
        <button type="button" :disabled="start + TEAM_PAGE_SIZE >= members.length" :aria-label="t('adminUsers.structure.nextStaff', { name: groupName })" @click="emit('update:page', currentPage + 1)">›</button>
      </div>
      <button type="button" class="ot-collapse" :aria-label="t('adminUsers.structure.collapseStaffFor', { name: groupName })" aria-expanded="true" @click="emit('update:page', -1)">{{ t('adminUsers.structure.collapseStaff') }}</button>
    </template>
    <button v-else-if="members.length > TEAM_PREVIEW_SIZE" type="button" class="ot-more" :aria-label="t('adminUsers.structure.moreStaffFor', { name: groupName, count: members.length - TEAM_PREVIEW_SIZE })" aria-expanded="false" @click="emit('update:page', 0)">{{ t('adminUsers.structure.moreStaff', { count: members.length - TEAM_PREVIEW_SIZE }) }}</button>
  </div>
</template>

<style scoped>
.ot { border-top: 1px solid var(--ui-border); }
.ot-heading { height: 28px; box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 14px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 11px); }
.ot-count { color: var(--ui-text); font-weight: 500; }
.ot-list { list-style: none; padding: 0 8px; margin: 0; }
.ot-person { display: flex; align-items: center; gap: 8px; height: 32px; width: 100%; padding: 0 6px; border: 0; background: transparent; color: var(--ui-text); border-radius: 6px; text-align: left; font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); cursor: pointer; }
.ot-person:hover, .ot-person[aria-pressed=true] { background: var(--ui-accent-soft); }
.ot-dot { width: 4px; height: 4px; background: var(--ui-text-muted); border-radius: 50%; flex-shrink: 0; }
.ot-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ot-more, .ot-collapse { height: 32px; display: block; box-sizing: border-box; width: calc(100% - 28px); padding: 0; margin: 0 14px; color: var(--ui-accent); font: inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); background: transparent; border: 0; text-align: left; cursor: pointer; }
.ot-collapse { height: 28px; font-size: calc(var(--ui-font-scale, 1) * 11px); }
.ot-pagination { display: flex; align-items: center; justify-content: space-between; gap: 6px; box-sizing: border-box; height: 36px; padding: 0 10px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 11px); }
.ot-pagination button { width: 29px; height: 29px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); background: var(--ui-surface); color: var(--ui-text); cursor: pointer; font: inherit; }
.ot-pagination button:disabled { opacity: .4; cursor: default; }
</style>
