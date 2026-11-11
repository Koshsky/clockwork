<script setup lang="ts">
import { t } from '../i18n'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { isOffline, reconnectDeadline } from './state'
import { retryConnectionNow } from './connection'

const busy = ref(false)

/** Whether the reconnect deadline is set (a next attempt is scheduled). */
const counting = computed(() => reconnectDeadline.value != null)

/** Seconds until the next automatic reconnect attempt (null while probing). */
const secondsLeft = ref<number | null>(null)

/** Refresh the remaining seconds from the wall-clock deadline. */
function updateSecondsLeft(): void {
  const deadline = reconnectDeadline.value
  secondsLeft.value = deadline == null ? null : Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
}

// The deadline is wall-clock time, so the countdown stays live even when the
// background countdown tick is throttled on a hidden tab — this component
// recomputes the remainder on its own lightweight timer.
let ticker: number | null = null
onMounted(() => {
  updateSecondsLeft()
  ticker = window.setInterval(updateSecondsLeft, 500)
})
onBeforeUnmount(() => {
  if (ticker != null) window.clearInterval(ticker)
  ticker = null
})

async function onRetry() {
  if (busy.value) return
  busy.value = true
  try {
    await retryConnectionNow()
  } finally {
    busy.value = false
    updateSecondsLeft()
  }
}
</script>

<template>
  <transition name="reconnect-fade">
    <div v-if="isOffline" class="reconnect-toast" role="status">
      <div class="reconnect-toast__title">
        <span class="reconnect-toast__dot" aria-hidden="true" />
        {{ t('offline.reconnect.offline') }}
      </div>
      <div class="reconnect-toast__body">
        <span v-if="busy" class="reconnect-toast__countdown">{{ t('offline.reconnect.checking') }}</span>
        <span v-else-if="counting" class="reconnect-toast__countdown">
          {{ t('offline.reconnect.attemptIn', { seconds: secondsLeft }) }}
        </span>
        <button
          type="button"
          class="reconnect-toast__retry"
          :disabled="busy"
          @click="onRetry"
        >
          {{ busy ? t('offline.reconnect.retrying') : t('offline.reconnect.retry') }}
        </button>
      </div>
    </div>
  </transition>
</template>

<style scoped>
@import '../styles/tokens.css';

.reconnect-toast {
  position: fixed;
  bottom: 20px;
  left: 20px;
  z-index: 1100;
  min-width: 280px;
  max-width: min(360px, calc(100vw - 40px));
  padding: 12px 14px;
  border-radius: var(--ui-radius-md);
  background: var(--ui-surface);
  color: var(--ui-text);
  border: 1px solid var(--ui-border-strong);
  box-shadow: var(--ui-shadow-md);
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  line-height: 1.35;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.reconnect-toast__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: var(--ui-text);
}

/* Offline indicator dot — a pulsing warning circle */
.reconnect-toast__dot {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ui-warning);
  animation: reconnect-pulse 1.4s ease-in-out infinite;
}

@keyframes reconnect-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

.reconnect-toast__body {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
}

.reconnect-toast__countdown {
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 12px);
}

.reconnect-toast__retry {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 6px 14px;
  font-size: calc(var(--ui-font-scale, 1) * 13px);
  font-weight: 600;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--ui-duration);
}

.reconnect-toast__retry:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}

.reconnect-toast__retry:disabled {
  opacity: 0.7;
  cursor: default;
}

.reconnect-fade-enter-active,
.reconnect-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.reconnect-fade-enter-from,
.reconnect-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>