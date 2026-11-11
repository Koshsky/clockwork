<script setup lang="ts">
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import { useAuthStore } from '../store'
import { PasswordField } from '../components/common'
import { isOffline, probeBackend } from '../offline/state'
import { isElectron } from '../electron'
import { getServerBase } from '../config'
import { t } from '../i18n'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

// Login fields
const username = ref('')
const password = ref('')

const localError = ref<string | null>(null)

const offline = computed(() => isOffline.value)
/** Server address to show on the login page (if set) */
const serverBase = computed(() => getServerBase())
/** The submit button always performs an ONLINE login (explicit user intent);
 *  offline entry has its own separate secondary button below. */
const submitLabel = computed(() => (auth.loading ? t('auth.submitWaiting') : t('auth.submit')))

// === Server ping: symbol button + connection indicator ===
const pinging = ref(false)
/** Ping result: null — not attempted yet, true — reachable, false — unreachable */
const pingOk = ref<boolean | null>(null)
// If the server is already known to be unreachable (offline) — the indicator is red right away
if (isOffline.value) pingOk.value = false

const pingSymbol = computed(() => (pinging.value ? '⏳' : '⇄'))

const pingClass = computed(() => {
  if (pinging.value) return 'pinging'
  if (pingOk.value === true) return 'ping-ok'
  if (pingOk.value === false) return 'ping-fail'
  return ''
})

const pingTitle = computed(() => {
  if (pinging.value) return t('auth.pingChecking')
  if (pingOk.value === true) return t('auth.pingOk')
  if (pingOk.value === false) return t('auth.pingFail')
  return t('auth.pingCheck')
})

/** Ping the backend (GET /health, public): any status < 500 means alive */
async function onPing() {
  if (pinging.value) return
  pinging.value = true
  pingOk.value = null
  try {
    pingOk.value = await probeBackend()
  } catch {
    pingOk.value = false
  } finally {
    pinging.value = false
  }
}

function getError(): string | null {
  return localError.value || auth.error
}

/**
 * Offline login: a local session without a token (data from the cache, mutations
 * go to a queue), the password is neither checked nor saved. Identity: typed
 * login → the saved profile (see the prefilled value below).
 */
function enterOffline() {
  const typed = username.value.trim()
  const identity = typed || auth.user?.username
  if (!identity) {
    localError.value = t('auth.noSession')
    return
  }
  auth.enterOffline(identity)
  goToRedirect()
}

async function onSubmit() {
  localError.value = null
  if (!username.value || !password.value) {
    localError.value = t('auth.fillAll')
    return
  }
  const ok = await auth.login(username.value, password.value)
  if (ok) {
    goToRedirect()
  }
}

/** Offline entry: explicit secondary action (only shown while the server is
 *  unreachable). Creates a local session without a token — never a substitute
 *  for the online submit, so an online login can never land in a token-less
 *  session by accident. */
function onOfflineClick() {
  localError.value = null
  // Re-probe first: if the server became reachable, prefer the online path.
  if (!isOffline.value) {
    onSubmit()
    return
  }
  enterOffline()
}

function goToRedirect() {
  const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/'
  router.push(redirect)
}
</script>

<template>
  <div class="lp">
    <div class="lp-form-side">
      <div class="lp-brand-head">
        <h1 class="lp-btitle">MVS ERP</h1>
        <p class="lp-bsub">{{ t('auth.subtitle') }}</p>
      </div>

      <form class="lp-form" @submit.prevent="onSubmit">
        <label class="lp-field">
          <span>{{ t('auth.login') }}</span>
          <input v-model="username" type="text" autocomplete="username" placeholder="ivanov" />
        </label>

        <PasswordField v-model="password" :label="t('auth.password')" autocomplete="current-password" placeholder="••••••••" />

        <p v-if="getError()" class="lp-error">{{ getError() }}</p>
        <p v-if="offline" class="lp-offline-hint">{{ t('auth.offlineHint') }}</p>

        <button type="submit" class="lp-btn" :disabled="auth.loading">
          {{ submitLabel }}
        </button>

        <button
          v-if="offline"
          type="button"
          class="lp-offline-btn"
          :disabled="auth.loading"
          @click="onOfflineClick"
        >
          {{ t('auth.offlineLogin') }}
        </button>
      </form>

      <!-- The connection ping — available in every environment (offline cache
           now works in the web too). The server-address text is shown where a
           settable base exists (desktop); on the web the address is fixed by
           the deployment. The "Настройки сервера" link stays desktop-only
           (same-origin restriction on the web). -->
      <div class="lp-server-row" :class="{ 'lp-server-row--no-base': !serverBase }">
        <span v-if="serverBase" class="lp-server">{{ t('auth.server', { base: serverBase }) }}</span>
        <button
          type="button"
          class="lp-ping"
          :class="pingClass"
          :disabled="pinging"
          :title="pingTitle"
          :aria-label="pingTitle"
          @click="onPing"
        >
          {{ pingSymbol }}
        </button>
      </div>

      <RouterLink v-if="isElectron" to="/login/settings" class="lp-settings-link">{{ t('auth.settingsLink') }}</RouterLink>
    </div>
  </div>
</template>

<style scoped>
@import '../styles/tokens.css';

.lp-offline-btn {
  margin-top: 8px;
  padding: 11px 13px;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface-2);
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), border-color var(--ui-duration);
}
.lp-offline-btn:hover:not(:disabled) {
  background: var(--ui-border);
  border-color: var(--ui-accent);
  color: var(--ui-text);
}
.lp-offline-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<style src="./LoginPage.css" scoped></style>

<style scoped>
/* Login-only overrides: single-column centered card.
   LoginPage.css stays untouched — it is shared with the server settings page. */
.lp {
  grid-template-columns: 1fr;
  max-width: 420px;
}

.lp-brand-head .lp-bsub {
  margin-bottom: 24px; /* tighten the gap before the form heading */
}
</style>