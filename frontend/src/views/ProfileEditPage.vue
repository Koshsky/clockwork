<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuthStore } from '../store'
import { PasswordField, PasswordRequirements } from '../components/common'
import { passwordRules, validatePassword } from '../composables/usePasswordValidation'
import { notifyError, notifySuccess } from '../notify/state'
import { t } from '../i18n'

defineProps<{ embedded?: boolean }>()

const auth = useAuthStore()

const oldPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')

const passwordChecks = [
  ...passwordRules(),
  {
    id: 'no-login',
    labelKey: 'adminUsers.profileEdit.ruleNoLogin',
    test: (value: string) => {
      const login = auth.user?.username?.toLowerCase() ?? ''
      return login === '' || !value.toLowerCase().includes(login)
    },
  },
]

const newPasswordValid = computed(() => validatePassword(newPassword.value, passwordChecks))
const passwordConfirmed = computed(() => confirmPassword.value === newPassword.value)

async function onChangePassword() {
  if (!oldPassword.value || !newPassword.value || !confirmPassword.value) {
    notifyError(t('adminUsers.profileEdit.error.fillAll'))
    return
  }
  if (!newPasswordValid.value) {
    notifyError(t('adminUsers.profileEdit.error.weak'))
    return
  }
  if (!passwordConfirmed.value) {
    notifyError(t('adminUsers.profileEdit.error.mismatch'))
    return
  }
  const ok = await auth.changePassword(oldPassword.value, newPassword.value)
  if (ok) {
    notifySuccess(t('adminUsers.profileEdit.success'))
    oldPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
  } else {
    notifyError(auth.error ?? t('adminUsers.profileEdit.error.changeFailed'))
  }
}
</script>

<template>
  <section class="pf" :class="{ 'pf--embedded': embedded }">
    <h2 v-if="!embedded" class="pf-title">{{ t('adminUsers.profileEdit.title') }}</h2>

    <div class="pf-cards">
      <div class="pf-card pw-form">
        <h3 class="pf-title sm">{{ t('adminUsers.profileEdit.changePassword') }}</h3>
        <form @submit.prevent="onChangePassword">
          <div class="pw-fields">
            <PasswordField id="profile-current-password" v-model="oldPassword" :label="t('adminUsers.profileEdit.field.oldPassword')" autocomplete="current-password" placeholder="••••••••" />
            <PasswordField id="profile-new-password" v-model="newPassword" :label="t('adminUsers.profileEdit.field.newPassword')" autocomplete="new-password" :placeholder="t('adminUsers.profileEdit.field.newPasswordPlaceholder')" />
            <PasswordField id="profile-confirm-password" v-model="confirmPassword" :label="t('adminUsers.profileEdit.field.confirmPassword')" autocomplete="new-password" :placeholder="t('adminUsers.profileEdit.field.confirmPasswordPlaceholder')" />
            <PasswordRequirements :model-value="newPassword" :rules="passwordChecks" />
          </div>

          <div class="pf-actions">
            <button type="submit" class="pf-btn" :disabled="auth.loading">
              {{ auth.loading ? t('adminUsers.profileEdit.action.saving') : t('adminUsers.profileEdit.action.submit') }}
            </button>
          </div>
        </form>
      </div>
    </div>

    <RouterLink v-if="!embedded" to="/profile" class="pf-back">{{ t('adminUsers.profileEdit.action.back') }}</RouterLink>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.pf-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin-bottom: 20px;
}

.pf-cards {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 720px;
}

.pf-card {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-sm);
  overflow: hidden;
}

.pf-title.sm {
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  margin: 0 0 16px;
}

.pw-form {
  padding: 20px;
}

.pw-fields {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.pf-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}

.pf-btn {
  padding: 10px 22px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration);
}
.pf-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.pf-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.pf-back {
  display: inline-block;
  margin-top: 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-accent);
  text-decoration: none;
}
.pf-back:hover {
  text-decoration: underline;
}

.pf--embedded .pf-cards { max-width: none; margin-top: 24px; }
.pf--embedded .pf-card { box-shadow: none; border-radius: 0; }
.pf--embedded .pw-form { padding: 0; }
.pf--embedded .pw-fields { max-width: 420px; }
.pf--embedded .pf-actions { justify-content: flex-start; }
.pf--embedded .pf-title.sm { font-size: calc(var(--ui-font-scale, 1) * 14px); color: var(--ui-text-muted); font-weight: 400; }
</style>