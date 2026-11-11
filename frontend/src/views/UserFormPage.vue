<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { HintButton, ConfirmDialog, PasswordDialog, UserPermissionsEditor } from '../components/common'
import { useAppStore, useAuthStore, useRbacStore } from '../store'
import { compareByName, translitPhio } from '../utils'
import { useConfirm } from '../composables/useConfirm'
import { builtinPresetOptions, presetDisplayName } from '../utils/presets'
import { t } from '../i18n'
import type { DtoAdminUserResponse, DtoCreateUserRequest, DtoUpdateUserRequest } from '@/api'
import type { PermissionOverride } from '../components/common/UserPermissionsEditor/types'

const route = useRoute()
const router = useRouter()
const app = useAppStore()
const auth = useAuthStore()
const rbac = useRbacStore()
const { adminUsers, users } = storeToRefs(app)

/**
 * Assigning a preset and per-user permissions is an admin-only business rule
 * (service + the rbac.manage gate): a non-admin holder of user_admin must
 * neither see the preset selector / permissions card nor send them in the
 * payload — the backend would reject the save. The gate mirrors rbac.manage
 * (the rbac_config virtual resource), which only admin holds via the bypass.
 * The preset is only a cold-start fallback before /permissions/me arrives — on
 * a page reload the empty matrix must not hide the editor from admin.
 */
const permsReady = computed(() => rbac.permsLoaded || rbac.myPermissions.length > 0)
const canManageUserRights = computed(() =>
  permsReady.value ? rbac.can('rbac_config', 'update') : auth.user?.preset === 'admin',
)

/**
 * One page for creating (users/new) and editing (users/:id/edit): the profile
 * card + the "Access permissions" card (admin). The mode comes from the route;
 * in edit mode the page loads the user list itself (so a direct URL / reload
 * works) and shows an error when the id is missing or unknown.
 */
const isEdit = computed(() => route.name === 'user-edit')

const editingUserId = computed(() => {
  const raw = route.params.id
  if (typeof raw !== 'string') return null
  const id = Number(raw)
  return Number.isFinite(id) && id > 0 ? id : null
})

const form = reactive({
  lastName: '',
  firstName: '',
  middleName: '',
  login: '',
  preset: 'worker',
  managerId: '', // '' — no manager
  position: '',
  hireDate: '',
  terminationDate: '',
})
/** Login was edited manually — autofill from the name is switched off */
const loginTouched = ref(false)

/** Load/save error: the user was not found (see missing); save errors are
 *  reported by the global toast (http.ts). */
const error = ref<string | null>(null)
const busy = ref(false)
/** Edit mode: the user list is loaded before the form is shown */
const loadingEdit = ref(isEdit.value && adminUsers.value.length === 0)
/** Edit mode: the user was not found (bad id / no rights / load error) */
const missing = ref(false)
/** The user's manager_id at load time — to detect a change on save */
const savedManagerId = ref<number | null>(null)
/** Username of the edited user at load (null in create mode). */
const savedLogin = ref<string | null>(null)
/** true after the first submit attempt — enables the validation message */
const submitAttempted = ref(false)

/** First field, focused on entry for immediate keyboard input */
const lastNameInput = ref<HTMLInputElement | null>(null)

// Live default login (create mode only): transliterated name, updated on input
watch(
  () => [form.lastName, form.firstName, form.middleName] as const,
  () => {
    if (loginTouched.value || isEdit.value) return
    form.login = translitPhio(form.lastName, form.firstName, form.middleName)
  },
)

/** Fallback options for a cold start (catalog not loaded yet). */
const staticPresetOptions = () => builtinPresetOptions()

/** Presets from /rbac/presets; the static list is the fallback. */
const presetOptions = computed(() =>
  rbac.presets.length
    ? rbac.presets.map((p) => ({ value: p.tag ?? '', label: presetDisplayName(p) }))
    : staticPresetOptions(),
)

/** Managers: users whose preset is not "worker" + "No manager" */
const managerOptions = computed(() => [
  { value: '', label: t('adminUsers.userForm.noManager') },
  ...users.value
    .filter((u) => u.id != null && u.preset !== 'worker')
    .sort(compareByName)
    .map((u) => ({ value: u.id as number, label: u.name ?? `#${u.id}` })),
])

function fillForm(u: DtoAdminUserResponse) {
  form.lastName = u.last_name ?? ''
  form.firstName = u.first_name ?? ''
  form.middleName = u.middle_name ?? ''
  form.login = u.username ?? ''
  form.preset = u.preset ?? 'worker'
  form.managerId = u.manager_id != null ? String(u.manager_id) : ''
  form.position = u.position ?? ''
  form.hireDate = u.hire_date ?? ''
  form.terminationDate = u.termination_date ?? ''
  savedManagerId.value = u.manager_id ?? null
  // Current login at load — the reserved-name exception: an unchanged reserved
  // login (e.g. the seeded "admin") stays editable; assigning/renaming to a
  // reserved word is still blocked (mirrors the backend).
  savedLogin.value = u.username ? u.username.toLowerCase() : null
  // In edit mode the login is entered manually — no autofill
  loginTouched.value = true
}

// === Individual permissions (admin) ===
/** Staged overrides (the whole set; the draft goes into the create payload,
 *  in edit mode they live on the separate /edit/access page). */
const permissionOverrides = ref<PermissionOverride[]>([])
/** The profile was saved successfully (shown next to the "Save" button) */
const profileSaved = ref(false)

/** Resets "Saved" after the profile is edited again */
watch(
  () =>
    [
      form.lastName,
      form.firstName,
      form.middleName,
      form.login,
      form.preset,
      form.managerId,
      form.position,
      form.hireDate,
      form.terminationDate,
    ] as const,
  () => {
    profileSaved.value = false
  },
)

onMounted(async () => {
  void rbac.ensurePresets()
  if (!users.value.length) void app.loadUsers()
  if (!isEdit.value) {
    await nextTick()
    lastNameInput.value?.focus()
    return
  }
  loadingEdit.value = adminUsers.value.length === 0
  await app.loadAdminUsers()
  loadingEdit.value = false
  const u = adminUsers.value.find((x) => x.id === editingUserId.value)
  if (u) fillForm(u)
  else missing.value = true
})

/** Strict login rule (mirrors the backend): always a username — only a–z/0–9/./
 * underscores, 3..20 chars, lowercase. Email logins are not supported. */
const LOGIN_PATTERN = /^[a-z0-9][a-z0-9._]{2,19}$/
const RESERVED_LOGINS = new Set(['admin', 'support', 'root', 'system', 'help'])

function loginError(login: string, required: boolean): string | null {
  const v = login.trim().toLowerCase()
  if (v === '') return required ? t('adminUsers.userForm.validation.loginRequired') : null
  // Reserved words may not be assigned or renamed to; an unchanged reserved
  // login of the edited user (e.g. the seeded "admin") keeps working.
  if (RESERVED_LOGINS.has(v) && v !== savedLogin.value) {
    return t('adminUsers.userForm.validation.loginReserved', { login: v })
  }
  if (!LOGIN_PATTERN.test(v)) {
    return t('adminUsers.userForm.validation.loginPattern')
  }
  return null
}

const loginErrorMsg = computed(() => loginError(form.login, isEdit.value))

// Live normalization: logins are stored lowercase (no User/user duplicates).
watch(
  () => form.login,
  (v) => {
    if (v !== v.toLowerCase()) form.login = v.toLowerCase()
  },
)

const canSubmit = computed(() => {
  if (busy.value || !rbac.can('user_admin', isEdit.value ? 'update' : 'create')) return false
  if (form.lastName.trim() === '' || form.firstName.trim() === '') return false
  // A login is always a username: blocked while empty/invalid in edit mode and
  // while invalid-but-non-empty in create mode (empty — autogenerated).
  if (loginErrorMsg.value != null) return false
  return true
})

/** Hint after a submit attempt with an invalid form */
const validationMessage = computed(() => {
  if (!submitAttempted.value || canSubmit.value) return null
  if (form.lastName.trim() === '' || form.firstName.trim() === '') {
    return t('adminUsers.userForm.validation.required')
  }
  return null
})

/** The generated password is shown once; closing returns to the list */
const passwordModal = ref<{ password: string; caption: string } | null>(null)

function onPasswordClose() {
  passwordModal.value = null
  void router.push('/users')
}

// === Reset password (edit mode only, admin-only — like the permissions editor) ===
const { confirm: confirmDialog, ask, proceed, cancel } = useConfirm()
const resetBusy = ref(false)
/** Generated password shown once after a reset (edit mode; stays on the page) */
const resetPasswordModal = ref<{ password: string; caption: string } | null>(null)

/** Display name of the edited user (from the form — the list may not contain them on a direct URL) */
const editedUserName = computed(() => {
  const fromList = adminUsers.value.find((x) => x.id === editingUserId.value)?.name
  if (fromList) return fromList
  return (
    [form.lastName, form.firstName].filter(Boolean).join(' ').trim() ||
    t('adminUsers.userForm.placeholderUserName')
  )
})

function askResetPassword() {
  ask(
    t('adminUsers.userForm.confirmReset'),
    () => {
      void onResetPassword()
    },
    t('adminUsers.userForm.confirmResetLabel'),
  )
}

async function onResetPassword() {
  const id = editingUserId.value
  if (id == null) return
  resetBusy.value = true
  try {
    const password = await app.resetPassword(id)
    // The generated password comes back from the backend once — show it.
    if (password) {
      resetPasswordModal.value = {
        password,
        caption: t('adminUsers.userForm.captionReset', { name: editedUserName.value }),
      }
    }
    // A failed reset is reported by the global toast (http.ts) — no inline banner.
  } finally {
    resetBusy.value = false
  }
}

async function onSubmit() {
  if (!canSubmit.value) {
    submitAttempted.value = true
    return
  }
  busy.value = true
  try {
    const common = {
      last_name: form.lastName.trim(),
      first_name: form.firstName.trim(),
    } as const
    if (isEdit.value) {
      const id = editingUserId.value
      if (id == null) return
      // Empty strings clear the fields (unlike undefined, which keeps the value)
      const patch: DtoUpdateUserRequest = {
        ...common,
        middle_name: form.middleName.trim(),
        username: form.login.trim(),
        position: form.position.trim(),
      }
      // Changing the preset is admin-only (service); a non-admin does not send it
      if (canManageUserRights.value) patch.preset = form.preset
      if (form.hireDate) patch.hire_date = form.hireDate
      if (form.terminationDate) patch.termination_date = form.terminationDate
      const ok = await app.updateUser(id, patch)
      const nextManager = form.managerId === '' ? null : Number(form.managerId)
      // A failed save is reported by the global toast (http.ts); the page
      // stays open with the entered values for a retry.
      if (ok && nextManager !== savedManagerId.value) await app.updateManager(id, nextManager)
      if (!ok) return
      // Saving the profile does NOT close the page (access permissions live on
      // the separate /edit/access page); on a repeated save the manager counts
      // as already saved.
      savedManagerId.value = nextManager
      profileSaved.value = true
      return
    }
    const payload: DtoCreateUserRequest = {
      ...common,
      middle_name: form.middleName.trim() || undefined,
      // A non-admin with user_admin.create may create only workers.
      preset: canManageUserRights.value ? form.preset : 'worker',
      position: form.position.trim(),
    }
    // Draft overrides are created together with the user (admin-only; the
    // backend validates them like /rbac/users/{id}/permissions).
    if (canManageUserRights.value && permissionOverrides.value.length) {
      payload.permissions = permissionOverrides.value.map((o) => ({
        resource: o.resource,
        action: o.action,
        scope: o.scope ?? '',
        granted: o.granted,
      }))
    }
    const login = form.login.trim()
    // The login is sent only when entered; an empty one is generated on the
    // backend (transliterated last name, uniqueness via a numeric suffix).
    if (login) payload.username = login
    if (form.hireDate) payload.hire_date = form.hireDate
    if (form.terminationDate) payload.termination_date = form.terminationDate
    if (form.managerId !== '') payload.manager_id = Number(form.managerId)
    const res = await app.createUser(payload)
    if (res && res.user) {
      if (res.password) {
        passwordModal.value = {
          password: res.password,
          caption: t('adminUsers.userForm.captionCreated', { name: res.user.name ?? '' }),
        }
      } else {
        void router.push('/users')
      }
    }
    // A failed creation is reported by the global toast (http.ts); the form
    // stays on the page for a retry.
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="ufp" :class="{ 'is-edit': isEdit }">
    <div class="ufp-head" :class="{ 'is-edit': isEdit }">
      <h2 class="ufp-title">
        {{ isEdit ? t('adminUsers.userForm.titleEdit') : t('adminUsers.userForm.titleCreate') }}
      </h2>
      <HintButton hint="user-form" />
      <!-- Option 3: the link to the permissions is a button in the header -->
      <button
        v-if="isEdit"
        type="button"
        class="ufp-head-access"
        :disabled="!canManageUserRights"
        :title="
          canManageUserRights
            ? t('adminUsers.userForm.access.openTitle')
            : t('adminUsers.userForm.access.openTitleDenied')
        "
        @click="router.push(`/users/${editingUserId}/edit/access`)"
      >
        {{ t('adminUsers.userForm.access.open') }}
      </button>
    </div>

    <!-- Edit mode: the list is loading — a placeholder instead of an empty form -->
    <p v-if="loadingEdit" class="ufp-st">{{ t('common.loading') }}</p>

    <!-- Edit mode: the user was not found — an error instead of the form -->
    <div v-else-if="missing" class="ufp-st">
      <p class="ufp-error">{{ error || t('adminUsers.userForm.missing') }}</p>
    </div>

    <div v-else :class="isEdit ? 'ufp-edit-wrap' : 'ufp-layout'">
      <!-- Profile card: edit mode — one wide card, create mode — the left
           (sticky) column -->
      <section :class="isEdit ? 'ufp-card-wrap' : 'ufp-aside'">
        <div class="ufp-card">
          <label class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.lastName') }}</span>
            <input ref="lastNameInput" v-model="form.lastName" type="text" class="ufp-input" autocomplete="off" />
          </label>
          <label class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.firstName') }}</span>
            <input v-model="form.firstName" type="text" class="ufp-input" autocomplete="off" />
          </label>
          <label class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.middleName') }}</span>
            <input v-model="form.middleName" type="text" class="ufp-input" autocomplete="off" :placeholder="t('adminUsers.userForm.field.middleNamePlaceholder')" />
          </label>
          <label class="ufp-field">
            <span class="ufp-label">
              {{ isEdit ? t('adminUsers.userForm.field.loginEdit') : t('adminUsers.userForm.field.loginLabel') }}
            </span>
            <input
              v-model="form.login"
              type="text"
              class="ufp-input"
              autocomplete="off"
              :placeholder="t('adminUsers.userForm.field.loginPlaceholder')"
              @input="loginTouched = true"
            />
            <span v-if="loginErrorMsg" class="ufp-hint er" role="alert">{{ loginErrorMsg }}</span>
          </label>
          <label class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.manager') }}</span>
            <select v-model="form.managerId" class="ufp-input ufp-select">
              <option v-for="opt in managerOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
            </select>
          </label>
          <label class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.position') }}</span>
            <input v-model="form.position" type="text" class="ufp-input" :placeholder="t('adminUsers.userForm.field.positionPlaceholder')" />
          </label>
          <div class="ufp-field">
            <span class="ufp-label">{{ t('adminUsers.userForm.field.dates') }}</span>
            <div class="ufp-row">
              <input v-model="form.hireDate" type="date" class="ufp-input" :aria-label="t('adminUsers.userForm.field.hireDate')" />
              <input v-model="form.terminationDate" type="date" class="ufp-input" :aria-label="t('adminUsers.userForm.field.terminationDate')" />
            </div>
          </div>

          <!-- Mutation failures are surfaced by the global toast (http.ts);
               inline errors here are only the load/not-found message above. -->
          <p v-if="validationMessage" class="ufp-error" role="alert">{{ validationMessage }}</p>

          <div class="ufp-actions">
            <button type="button" class="ufp-btn" @click="router.push('/users')">
              {{ t('adminUsers.userForm.action.back') }}
            </button>
            <button
              v-if="isEdit && canManageUserRights"
              type="button"
              class="ufp-btn ufp-reset"
              :disabled="resetBusy"
              :title="t('adminUsers.userForm.action.resetPasswordTitle')"
              @click="askResetPassword"
            >
              {{ resetBusy ? t('adminUsers.userForm.action.resetting') : t('adminUsers.userForm.action.resetPassword') }}
            </button>
            <button type="button" class="ufp-add" :disabled="!canSubmit" @click="onSubmit">
              {{
                busy
                  ? isEdit
                    ? t('adminUsers.userForm.action.saving')
                    : t('adminUsers.userForm.action.creating')
                  : isEdit
                    ? t('common.save')
                    : t('common.create')
              }}
            </button>
          </div>
          <p v-if="profileSaved" class="ufp-ok" role="status">{{ t('adminUsers.userForm.action.saved') }}</p>
        </div>
      </section>

      <!-- Right column (create only): the permissions draft (admin only,
           the overrides go into the create payload) -->
      <main v-if="!isEdit" class="ufp-main">
        <div v-if="canManageUserRights" class="ufp-perms">
          <!-- Permissions draft on create: the preset switch lives in the editor
               header, the overrides go into the create payload. -->
          <UserPermissionsEditor
            mode="draft"
            :preset="form.preset"
            :preset-options="presetOptions"
            :user-id="0"
            @update:preset="form.preset = $event"
            @update:overrides="permissionOverrides = $event"
          />
        </div>
      </main>
    </div>

    <PasswordDialog
      :open="passwordModal !== null"
      :password="passwordModal?.password ?? ''"
      :caption="passwordModal?.caption ?? ''"
      @close="onPasswordClose"
    />

    <!-- Reset-password confirmation (edit mode, admin) -->
    <ConfirmDialog
      :open="!!confirmDialog"
      :message="confirmDialog?.message ?? ''"
      :confirm-label="confirmDialog?.confirmLabel"
      @confirm="proceed"
      @close="cancel"
    />

    <!-- Generated password shown once (after a reset in the user editor) -->
    <PasswordDialog
      :open="resetPasswordModal !== null"
      :password="resetPasswordModal?.password ?? ''"
      :caption="resetPasswordModal?.caption ?? ''"
      @close="resetPasswordModal = null"
    />
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.ufp {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 1200px;
  margin: 0 auto;
}
.ufp-head {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
}
.ufp-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
/* Two equal-width columns, centered */
.ufp-layout {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  align-items: start;
}
.ufp-aside {
  position: sticky;
  top: 16px;
  min-width: 0;
}
.ufp-main {
  min-width: 0;
}
@media (max-width: 860px) {
  .ufp-layout {
    grid-template-columns: 1fr;
  }
  .ufp-aside {
    position: static;
  }
}
/* Edit mode: the whole page (header + profile card) is one centered block;
   the title on the left, the permissions button in the header row */
.ufp.is-edit {
  max-width: 720px;
}
.ufp-head.is-edit {
  align-items: center;
}
.ufp-head.is-edit .ufp-head-access {
  margin-left: auto;
}
.ufp-edit-wrap {
  min-width: 0;
}
.ufp-card-wrap {
  min-width: 0;
}
.ufp-card {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-sm);
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ufp-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.ufp-perms {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ufp-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ufp-label {
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-text-2);
  font-weight: 500;
}
.ufp-input {
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
}
.ufp-input:focus {
  border-color: var(--ui-accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-accent) 18%, transparent);
}
.ufp-select {
  cursor: pointer;
}
.ufp-hint {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
}
.ufp-hint.er {
  color: var(--ui-danger);
  font-weight: 500;
}
.ufp-error {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-danger);
}
.ufp-ok {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-success, #22c55e);
}
/* The permissions button in the page header sits right after the title,
   not at the far edge of a wide column */
.ufp-head-access {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  padding: 8px 16px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  color: var(--ui-accent);
  cursor: pointer;
  white-space: nowrap;
}
.ufp-head-access:hover:not(:disabled) {
  background: var(--ui-accent-soft);
}
.ufp-head-access:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.ufp-st {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  padding: 30px;
  text-align: center;
}
.ufp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 2px;
}
.ufp-btn {
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-surface);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  color: var(--ui-accent);
  cursor: pointer;
  white-space: nowrap;
}
.ufp-btn:hover {
  background: var(--ui-accent-soft);
}
/* Reset-password action: secondary button with the danger tint */
.ufp-reset {
  border-color: color-mix(in srgb, var(--ui-danger) 35%, transparent);
  color: var(--ui-danger);
}
.ufp-reset:hover:not(:disabled) {
  background: var(--ui-danger-soft);
}
.ufp-add {
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
.ufp-add:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.ufp-add:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
</style>