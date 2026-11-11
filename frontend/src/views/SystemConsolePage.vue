<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { t } from '@/i18n'
import { useAuthStore } from '../store'
import { getApiUrl, setApiUrl, hasApiUrlOverride, httpSchemeWarning } from '../config'
import { warmNow, warmupProgress } from '../offline/warmup'
import { syncNow, syncAll, syncNotice } from '../offline/sync'
import { pendingCount, pushProgress, refreshPendingCount } from '../offline/outbox'
import { isOffline } from '../offline/state'
import { notifyError, notifyInfo, notifySuccess } from '../notify/state'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const busy = ref(false)
const apiUrl = ref('')

let refreshTimer: number | null = null

const pendingLabel = computed(() => (pendingCount.value > 0 ? `PUSH (${pendingCount.value})` : 'PUSH'))

/** Percentage of the sent queue (for the PUSH progress bar) */
const pushPercent = computed(() => {
  const p = pushProgress.value
  if (!p || p.total === 0) return 0
  return Math.round((p.done / p.total) * 100)
})

const connectionLabel = computed(() =>
  isOffline.value
    ? t('adminSystem.console.connection.offline')
    : t('adminSystem.console.connection.online'),
)

function requireAuth(): boolean {
  if (auth.isAuthenticated) return true
  void router.push({ name: 'login', query: { redirect: route.fullPath } })
  return false
}

function applyApiUrl(): boolean {
  const warn = httpSchemeWarning(apiUrl.value)
  if (warn) notifyInfo(warn)
  const applied = setApiUrl(apiUrl.value, true)
  if (!applied) {
    notifyError(t('adminSystem.console.messages.invalidApiUrl'))
  }
  return applied
}

async function refreshStatus() {
  await refreshPendingCount().catch(() => {})
}

/** PULL: warm the offline data cache (desktop only — warmNow is No-op on web) */
async function onPull() {
  if (busy.value) return
  busy.value = true
  try {
    if (!requireAuth()) return
    if (!applyApiUrl()) return
    if (isOffline.value) {
      notifyError(t('adminSystem.console.messages.offlinePull'))
      return
    }
    const ran = await warmNow(true)
    if (ran) {
      notifySuccess(t('adminSystem.console.messages.warmed'))
    } else if (isOffline.value) {
      notifyError(t('adminSystem.console.messages.warmupOffline'))
    } else {
      notifyError(t('adminSystem.console.messages.warmupRunning'))
    }
    await refreshStatus()
  } finally {
    busy.value = false
  }
}

/**
 * PUSH: send the queued changes. Kept for compatibility with the old Sync
 * screen — the recommended path is "Sync everything".
 */
async function onPush() {
  if (busy.value) return
  busy.value = true
  try {
    await syncNow()
    const n = syncNotice.value
    if (n?.interrupted) {
      notifyError(t('adminSystem.console.messages.pushInterrupted', { ok: n.ok }))
    } else if (n && n.failed > 0) {
      notifyError(t('adminSystem.console.messages.pushFailed', { ok: n.ok, failed: n.failed }))
    } else if (n) {
      notifySuccess(t('adminSystem.console.messages.pushDone', { ok: n.ok }))
    } else {
      notifySuccess(t('adminSystem.console.messages.pushNothing'))
    }
    await refreshStatus()
  } finally {
    busy.value = false
  }
}

/** "Sync everything": PUSH (send the queue) → PULL (warmup) */
async function onSyncAll() {
  if (busy.value) return
  busy.value = true
  try {
    if (!requireAuth()) return
    if (!applyApiUrl()) return
    if (isOffline.value) {
      notifyError(t('adminSystem.console.messages.offlineSync'))
      return
    }
    const res = await syncAll()
    const n = syncNotice.value
    const parts: string[] = []
    if (res.pushed) {
      parts.push(t('adminSystem.console.messages.syncPushed', { ok: n?.ok ?? 0 }))
    }
    if (res.pulled) parts.push(t('adminSystem.console.messages.syncPulled'))
    if (parts.length > 0) {
      notifySuccess(t('adminSystem.console.messages.syncDone', { parts: parts.join(', ') }))
    } else if (n && n.failed > 0) {
      notifyError(t('adminSystem.console.messages.pushFailed', { ok: n.ok, failed: n.failed }))
    } else {
      notifySuccess(t('adminSystem.console.messages.syncNothing'))
    }
    await refreshStatus()
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  apiUrl.value = getApiUrl() ?? ''
  void refreshStatus()
  refreshTimer = window.setInterval(refreshStatus, 5000)
})

onBeforeUnmount(() => {
  if (refreshTimer != null) window.clearInterval(refreshTimer)
})
</script>

<template>
  <section class="sp">
    <h2 class="sp-title">{{ t('adminSystem.console.title') }}</h2>

    <div class="sp-card">
      <h3 class="sp-card-title">{{ t('adminSystem.console.sync.title') }}</h3>

      <div class="sp-status-rows">
        <div class="sp-row">
          <span class="sp-label">{{ t('adminSystem.console.sync.connection') }}</span>
          <span class="sp-value" :class="isOffline ? 'off' : 'on'">
            {{ connectionLabel }}
          </span>
        </div>
        <div class="sp-row">
          <span class="sp-label">{{ t('adminSystem.console.sync.pending') }}</span>
          <span class="sp-value">{{ pendingCount }}</span>
        </div>
        <div class="sp-row">
          <span class="sp-label">{{ t('adminSystem.console.sync.apiUrlSource') }}</span>
          <span class="sp-value">
            {{
              hasApiUrlOverride()
                ? t('adminSystem.console.sync.sourceManual')
                : t('adminSystem.console.sync.sourceDefault')
            }}
          </span>
        </div>
      </div>

      <div v-if="warmupProgress != null" class="warm-progress" role="progressbar" :aria-valuenow="warmupProgress">
        <div class="warm-bar">
          <div class="warm-fill" :style="{ width: warmupProgress + '%' }" />
        </div>
        <span class="warm-label">
          {{ t('adminSystem.console.sync.warmProgress', { percent: warmupProgress }) }}
        </span>
      </div>

      <div v-if="pushProgress != null" class="warm-progress" role="progressbar" :aria-valuenow="pushPercent">
        <div class="warm-bar">
          <div class="warm-fill warm-fill--push" :style="{ width: pushPercent + '%' }" />
        </div>
        <span class="warm-label">
          {{
            t('adminSystem.console.sync.pushProgress', {
              done: pushProgress.done,
              total: pushProgress.total,
            })
          }}
        </span>
      </div>

      <div class="sp-actions">
        <button type="button" class="sp-btn" :disabled="busy || isOffline" @click="onPull">
          {{ t('adminSystem.console.sync.pull') }}
        </button>
        <button type="button" class="sp-btn accent" :disabled="busy" @click="onPush">
          {{ pendingLabel }}
        </button>
      </div>

      <div class="sp-actions">
        <button type="button" class="sp-btn accent" :disabled="busy || isOffline" @click="onSyncAll">
          {{ t('adminSystem.console.sync.syncAll') }}
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.sp-title {
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
  margin-bottom: 20px;
}

.sp-card {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-md);
  padding: 20px;
}

.sp-card-title {
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0 0 16px;
}

.sp-status-rows {
  margin-bottom: 6px;
}

.sp-row {
  display: flex;
  justify-content: space-between;
  padding: 9px 0;
  border-bottom: 1px solid var(--ui-border);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
}

.sp-row:last-child {
  border-bottom: none;
}

.sp-label {
  color: var(--ui-text-muted);
}

.sp-value {
  font-weight: 600;
  color: var(--ui-text);
}

.sp-value.on {
  color: var(--ui-success);
}

.sp-value.off {
  color: var(--ui-warning);
}

.sp-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}

.sp-btn {
  margin-top: 14px;
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), opacity var(--ui-duration);
}

.sp-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}

.sp-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.sp-btn.accent {
  background: var(--ui-success);
}

.sp-btn.accent:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-success) 88%, black);
}

.sp-actions .sp-btn {
  width: auto;
  margin-top: 14px;
}

.warm-progress {
  margin: 4px 0 2px;
}

.warm-bar {
  height: 8px;
  border-radius: 999px;
  background: var(--ui-surface-3);
  overflow: hidden;
}

.warm-fill {
  height: 100%;
  border-radius: 999px;
  background: var(--ui-accent);
  transition: width var(--ui-duration) ease;
}

.warm-fill--push {
  background: var(--ui-success);
}

.warm-label {
  display: block;
  margin-top: 6px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-2);
  text-align: right;
}
</style>
