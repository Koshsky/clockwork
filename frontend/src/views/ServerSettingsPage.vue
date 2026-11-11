<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { t } from '@/i18n'
import { getServerBase, getApiUrl, setServerBase, httpSchemeWarning } from '../config'
import { isElectron } from '../electron'

/**
 * Server address settings screen (before login).
 * In the desktop (Electron) version it lets you choose which backend to
 * connect to: the user enters the server base address, the app
 * appends /api/v1 (the address on the machine with the exe may differ).
 * In the browser version changing the address is impossible (same-origin nginx proxy,
 * CSP connect-src 'self', the refresh cookie does not survive an origin change) — the screen
 * shows the deployed address as information only, without editing.
 */

const router = useRouter()

const serverBase = ref(getServerBase())
const busy = ref(false)
const msg = ref<string | null>(null)
const ok = ref(false)
/** Warning about the http scheme (the refresh Secure cookie does not work) */
const warning = ref<string | null>(null)

function applyAndStore(url: string): boolean {
  const saved = setServerBase(url, true)
  warning.value = httpSchemeWarning(url)
  if (!saved) {
    msg.value = t('adminSystem.server.invalidAddress')
    ok.value = false
  }
  return saved
}

/** Whether the server is alive: POST /auth/login returns <500 (401 "bad credentials" also counts) */
async function probeServer(): Promise<boolean> {
  const base = getApiUrl()
  if (!base) return false
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 5000)
  try {
    const res = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'probe', password: 'probe' }),
      signal: ctrl.signal,
    })
    return res.status < 500
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

async function onCheck() {
  if (busy.value) return
  busy.value = true
  msg.value = null
  try {
    if (!applyAndStore(serverBase.value)) return
    const reachable = await probeServer()
    if (reachable) {
      msg.value = t('adminSystem.server.reachable')
      ok.value = true
    } else {
      msg.value = t('adminSystem.server.unreachable')
      ok.value = false
    }
  } finally {
    busy.value = false
  }
}

function onSave() {
  if (!applyAndStore(serverBase.value)) return
  void router.push({ name: 'login' })
}
</script>

<template>
  <div class="lp ss">
    <div class="lp-brand">
      <div class="lp-logo">MVS</div>
      <h1 class="lp-btitle">{{ t('adminSystem.server.brandTitle') }}</h1>
      <p class="lp-bsub">{{ t('adminSystem.server.brandSubtitle') }}</p>

      <ul class="lp-features">
        <li class="feature">
          <span class="feature-icon">🌐</span>
          <span class="feature-body">
            <strong>{{ t('adminSystem.server.featureLocal') }}</strong>
            <em>{{ t('adminSystem.server.featureLocalExample') }}</em>
          </span>
        </li>
        <li class="feature">
          <span class="feature-icon">🏢</span>
          <span class="feature-body">
            <strong>{{ t('adminSystem.server.featureRemote') }}</strong>
            <em>{{ t('adminSystem.server.featureRemoteExample') }}</em>
          </span>
        </li>
        <li class="feature">
          <span class="feature-icon">🔐</span>
          <span class="feature-body">
            <strong>{{ t('adminSystem.server.featureSecure') }}</strong>
            <em>{{ t('adminSystem.server.featureSecureNote') }}</em>
          </span>
        </li>
      </ul>
    </div>

    <div class="lp-form-side">
      <h2 class="lp-title">{{ t('adminSystem.server.title') }}</h2>

      <!-- Electron: the address can be set (the exe connects to an external backend) -->
      <template v-if="isElectron">
        <p class="lp-subtitle">{{ t('adminSystem.server.subtitle') }}</p>

        <form class="lp-form" @submit.prevent="onSave">
          <label class="lp-field">
            <span>{{ t('adminSystem.server.address') }}</span>
            <input
              v-model="serverBase"
              type="text"
              spellcheck="false"
              autocomplete="url"
              :placeholder="t('adminSystem.server.addressPlaceholder')"
            />
          </label>

          <p v-if="warning" class="lp-warn">{{ warning }}</p>
          <p v-if="msg" class="lp-error" :class="{ ok }">{{ msg }}</p>

          <button type="button" class="lp-btn" :disabled="busy" @click="onCheck">
            {{ busy ? t('adminSystem.server.checking') : t('adminSystem.server.check') }}
          </button>
          <button type="submit" class="lp-btn" :disabled="busy">
            {{ t('adminSystem.server.save') }}
          </button>
        </form>
      </template>

      <!-- Web: the address is set by the deployment (same-origin nginx proxy) — information only -->
      <template v-else>
        <p class="lp-subtitle">
          {{ t('adminSystem.server.webSubtitle') }}
        </p>

        <div class="ss-info">
          <span class="ss-label">{{ t('adminSystem.server.serverLabel') }}</span>
          <code class="ss-value">{{ serverBase || '—' }}</code>
        </div>
        <div class="ss-info">
          <span class="ss-label">API</span>
          <code class="ss-value">{{ getApiUrl() || '—' }}</code>
        </div>
      </template>

      <RouterLink to="/login" class="ss-back">{{ t('adminSystem.server.backToLogin') }}</RouterLink>
    </div>
  </div>
</template>

<style src="./LoginPage.css" scoped></style>

<style scoped>
@import '../styles/tokens.css';

/* Error with the success flag — in green */
.lp-error.ok {
  color: var(--ui-success);
}

.ss-back {
  display: block;
  text-align: center;
  margin-top: 12px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  color: var(--ui-accent);
  text-decoration: none;
}

/* Address info card (web: changing the server is unavailable) */
.ss-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 14px;
  border: 1px solid var(--ui-border);
  border-radius: 10px;
  background: var(--ui-surface-2);
  margin-bottom: 10px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}

.ss-label {
  color: var(--ui-text-muted);
  font-weight: 600;
  white-space: nowrap;
}

.ss-value {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--ui-text);
  word-break: break-all;
  text-align: right;
}

.ss-back:hover {
  text-decoration: underline;
}
</style>
