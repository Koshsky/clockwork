<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { dismissSyncNotice, syncNotice, retryFailed, discardFailed } from './sync'
import { t } from '../i18n'

const visible = ref(false)
const busy = ref(false)
let timer: number | null = null

const failedItems = computed(() => syncNotice.value?.failedEntries ?? [])

watch(syncNotice, (n) => {
  if (!n) return
  visible.value = true
  if (timer != null) {
    window.clearTimeout(timer)
    timer = null
  }
  // While there are rejected entries, the toast stays visible: user action is required.
  if (failedItems.value.length === 0) {
    timer = window.setTimeout(() => {
      visible.value = false
      dismissSyncNotice()
    }, 5000)
  }
})

onBeforeUnmount(() => {
  if (timer != null) window.clearTimeout(timer)
})

function shortUrl(url: string): string {
  try {
    const u = new URL(url, window.location.origin)
    return u.pathname + u.search
  } catch {
    return url
  }
}

async function onRetry() {
  if (busy.value) return
  busy.value = true
  try {
    await retryFailed()
  } finally {
    busy.value = false
  }
}

async function onDiscard() {
  if (busy.value) return
  busy.value = true
  try {
    await discardFailed()
    dismissSyncNotice()
  } finally {
    busy.value = false
  }
}

/** Close the notice, deferring error handling: the queue is untouched. */
function onClose() {
  visible.value = false
  dismissSyncNotice()
}
</script>

<template>
  <transition name="toast-fade">
    <div
      v-if="visible && syncNotice"
      class="sync-toast"
      :class="{ error: syncNotice.failed > 0 || syncNotice.interrupted }"
      role="status"
    >
      <button
        type="button"
        class="sync-toast__close"
        :aria-label="t('offline.sync.close')"
        :title="t('offline.sync.postpone')"
        @click="onClose"
      >
        ×
      </button>
      <template v-if="syncNotice.interrupted">
        {{ t('offline.sync.networkLost', { ok: syncNotice.ok }) }}
      </template>
      <template v-else-if="failedItems.length > 0">
        <div class="sync-toast__head">
          {{ t('offline.sync.doneWithErrors', { ok: syncNotice.ok, failed: failedItems.length }) }}
        </div>
        <ul class="sync-toast__list">
          <li v-for="(it, i) in failedItems.slice(0, 5)" :key="i" class="sync-toast__item">
            <span class="sync-toast__req">{{ it.method }} {{ shortUrl(it.url) }}</span>
            <span class="sync-toast__msg">{{ it.message }}</span>
          </li>
        </ul>
        <div class="sync-toast__actions">
          <button type="button" class="sync-btn" :disabled="busy" @click="onRetry">{{ t('offline.sync.retry') }}</button>
          <button type="button" class="sync-btn sync-btn--ghost" :disabled="busy" @click="onDiscard">
            {{ t('offline.sync.skip') }}
          </button>
        </div>
      </template>
      <template v-else>{{ t('offline.sync.done', { ok: syncNotice.ok }) }}</template>
    </div>
  </transition>
</template>

<style scoped>
@import '../styles/tokens.css';

.sync-toast {
  position: fixed;
  /* Bottom-left corner, stacked ABOVE the reconnect toast when both are
     visible (reconnect = bottom 20px, sync = 110px) so they never overlap. */
  bottom: 110px;
  left: 20px;
  z-index: 1001;
  background: var(--ui-success);
  color: var(--ui-accent-on);
  padding: 10px 30px 10px 18px;
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-md);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  max-width: 90vw;
  min-width: 300px;
  text-align: center;
}

.sync-toast.error {
  background: var(--ui-danger);
}

.sync-toast__close {
  position: absolute;
  top: 4px;
  right: 8px;
  background: transparent;
  border: none;
  color: color-mix(in srgb, var(--ui-accent-on) 85%, transparent);
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.sync-toast__close:hover {
  background: color-mix(in srgb, var(--ui-accent-on) 15%, transparent);
  color: var(--ui-accent-on);
}

.sync-toast__head {
  font-weight: 600;
  margin-bottom: 6px;
}

.sync-toast__list {
  margin: 0 0 8px;
  padding: 0;
  list-style: none;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.sync-toast__item {
  background: color-mix(in srgb, var(--ui-accent-on) 18%, transparent);
  border-radius: 6px;
  padding: 5px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}

.sync-toast__req {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  opacity: 0.9;
  word-break: break-all;
}

.sync-toast__msg {
  opacity: 0.8;
}

.sync-toast__actions {
  display: flex;
  gap: 8px;
  justify-content: center;
}

.sync-btn {
  background: var(--ui-accent-on);
  color: var(--ui-danger);
  border: none;
  border-radius: 6px;
  padding: 6px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  cursor: pointer;
}

.sync-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.sync-btn--ghost {
  background: transparent;
  color: var(--ui-accent-on);
  border: 1px solid color-mix(in srgb, var(--ui-accent-on) 60%, transparent);
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
</style>
