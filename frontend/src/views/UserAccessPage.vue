<script setup lang="ts">
/**
 * UserAccessPage — individual user permissions (zone overrides).
 * A separate page reached from the "Edit permissions" button of the user
 * editor (/users/:id/edit). A preset change is saved immediately (it is a
 * profile property), the overrides — with the "Save" button below.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { UserPermissionsEditor } from '../components/common'
import { useAppStore, useAuthStore, useRbacStore } from '../store'
import { builtinPresetOptions, presetDisplayName } from '../utils/presets'
import { t } from '../i18n'
import type { PermissionOverride } from '../components/common/UserPermissionsEditor/types'

const route = useRoute()
const router = useRouter()
const app = useAppStore()
const auth = useAuthStore()
const rbac = useRbacStore()
const { adminUsers } = storeToRefs(app)
const editor = ref<InstanceType<typeof UserPermissionsEditor> | null>(null)
const permissionSaving = ref(false)
const presetSaving = ref(false)

const staticPresetOptions = () => builtinPresetOptions()
const presetOptions = computed(() =>
  rbac.presets.length
    ? rbac.presets.map((p) => ({ value: p.tag ?? '', label: presetDisplayName(p) }))
    : staticPresetOptions(),
)

/** Permission editing is admin-only (as on the user editor page). */
const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)
const canManageUserRights = computed(() =>
  permsReady.value ? rbac.can('rbac_config', 'update') : auth.user?.preset === 'admin',
)

const userId = computed(() => {
  const raw = route.params.id
  if (typeof raw !== 'string') return null
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
})

const loading = ref(true)
const missing = ref(false)
const user = ref<{ id: number; name: string; username: string; preset: string } | null>(null)

async function loadUser() {
  const id = userId.value
  loading.value = true
  missing.value = false
  user.value = null
  permissionDirty.value = false
  permissionSaved.value = false
  void rbac.ensurePresets()
  await app.loadAdminUsers()
  if (id !== userId.value) return
  const found = adminUsers.value.find((entry) => entry.id === id)
  user.value = found ? {
    id: found.id ?? 0,
    name: found.name ?? found.username ?? `#${found.id}`,
    username: found.username ?? '',
    preset: found.preset ?? 'worker',
  } : null
  missing.value = !found
  loading.value = false
}
onMounted(loadUser)
watch(userId, loadUser)

/* ── overrides (staged) + saving ─────────────── */
const permissionOverrides = ref<PermissionOverride[]>([])
const permissionDirty = ref(false)
const permissionSaved = ref(false)

async function savePermissions(): Promise<boolean> {
  const id = userId.value
  if (id == null || permissionSaving.value || presetSaving.value) return false
  permissionSaving.value = true
  const overrides = permissionOverrides.value.map((rule) => ({ ...rule }))
  try {
    const ok = await rbac.saveUserPermissions(id, overrides)
    if (!ok || id !== userId.value) return false
    permissionSaved.value = true
    await rbac.loadUserPermissions(id)
    return true
  } finally {
    permissionSaving.value = false
  }
}

function cancelPermissions() {
  editor.value?.cancelChanges()
  permissionSaved.value = false
}

async function onChangePreset(preset: string) {
  const id = userId.value
  if (id == null || !user.value || user.value.preset === preset || presetSaving.value || permissionSaving.value) return
  const previous = user.value.preset
  user.value.preset = preset
  presetSaving.value = true
  try {
    const ok = await app.updateUser(id, { preset })
    if (!ok && id === userId.value && user.value) user.value.preset = previous
    if (ok && id === userId.value) permissionSaved.value = false
  } finally {
    presetSaving.value = false
  }
}

watch(permissionDirty, (dirty) => {
  if (dirty) permissionSaved.value = false
})
</script>

<template>
  <section class="ua">
    <div class="ua-head">
      <h2 class="ua-title">{{ t('adminUsers.userAccess.title', { name: user?.name ?? '…' }) }}</h2>
      <button type="button" class="ua-back" @click="router.push(`/users/${userId}/edit`)">
        {{ t('adminUsers.userAccess.back') }}
      </button>
    </div>

    <p v-if="loading" class="ua-st">{{ t('common.loading') }}</p>
    <div v-else-if="missing" class="ua-st">
      <p class="ua-error">{{ t('adminUsers.userAccess.missing') }}</p>
    </div>

    <p v-else-if="!canManageUserRights" class="ua-st">
      {{ t('adminUsers.userAccess.denied') }}
    </p>

    <div v-else class="ua-card">
      <UserPermissionsEditor
        ref="editor"
        :key="userId ?? 0"
        mode="user"
        :busy="permissionSaving || presetSaving"
        :user-id="userId ?? 0"
        :preset="user?.preset ?? 'worker'"
        :preset-options="presetOptions"
        @update:preset="onChangePreset"
        @update:overrides="permissionOverrides = $event"
        @update:dirty="permissionDirty = $event"
      />

      <p v-if="permissionSaved && !permissionDirty" class="ua-ok" role="status">{{ t('adminUsers.userAccess.saved') }}</p>
      <div v-if="permissionDirty" class="ua-actions">
        <span class="ua-change-note">{{ t('adminConfig.editor.unsaved') }}</span>
        <button
          type="button"
          class="ua-save"
          :disabled="permissionSaving || presetSaving"
          @click="savePermissions"
        >
          {{ permissionSaving ? t('adminUsers.userForm.action.saving') : t('common.save') }}
        </button>
        <button type="button" class="ua-cancel" :disabled="permissionSaving || presetSaving" @click="cancelPermissions">{{ t('adminConfig.presets.cancel') }}</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';
.ua {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  box-sizing: border-box;
  margin: 0 auto;
  padding: 16px;
}
.ua-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.ua-title {
  font-size: calc(var(--ui-font-scale, 1) * 20px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
.ua-back {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  padding: 7px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-accent);
  cursor: pointer;
}
.ua-back:hover {
  background: var(--ui-accent-soft);
}
.ua-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ua-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.ua-error {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}
.ua-ok {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-success, #22c55e);
}
.ua-actions {
  position: sticky;
  bottom: 12px;
  z-index: var(--z-content-top);
  padding: 12px 16px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface);
  box-shadow: var(--ui-shadow-sm);
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
}
.ua-save {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
}
.ua-change-note { margin-right: auto; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 13px); }
.ua-cancel { border: 1px solid var(--ui-border-strong); background: var(--ui-surface); color: var(--ui-text-2); border-radius: var(--ui-radius-sm); padding: 8px 16px; font: inherit; font-size: calc(var(--ui-font-scale, 1) * 13px); cursor: pointer; }
.ua-cancel:disabled { opacity: .55; cursor: not-allowed; }
@media (max-width: 520px) { .ua-actions { flex-wrap: wrap; } .ua-change-note { flex-basis: 100%; } }
.ua-save:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>