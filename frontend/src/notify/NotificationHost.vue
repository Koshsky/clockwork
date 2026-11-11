<script setup lang="ts">
import { notifications, dismissNotification } from './state'
import { notificationsEnabled } from '../settings'
import { isNavOpen, NAV_WIDTH } from '../composables/useNavDrawer'
import { t } from '../i18n'

const BASE_LEFT = 20
</script>

<template>
  <!-- Generic notification stack, pinned to the bottom-left edge of the
       viewport. The navigation drawer is a real layout column: when it opens
       (pinned or peeked) the app content shifts right by NAV_WIDTH — the
       stack follows with the same easing so it never overlaps the panel.
       The column grows upward from the bottom edge: the newest notification
       sits closest to the corner, older ones above it. Unmounted entirely
       while the user has the stack switched off in Settings. -->
  <div
    v-if="notificationsEnabled"
    class="nhost"
    :style="{ left: (isNavOpen ? NAV_WIDTH : 0) + BASE_LEFT + 'px' }"
    aria-live="polite"
  >
    <TransitionGroup name="nt-fade">
      <div v-for="n in notifications" :key="n.id" class="nt" :class="`nt--${n.kind}`" role="alert">
        <!-- No countdown bar for never-auto-hide notifications (durationMs = 0). -->
        <div
          v-if="n.durationMs > 0"
          class="nt-timer"
          :style="{ animationDuration: `${n.durationMs}ms` }"
          aria-hidden="true"
        ></div>
        <span class="nt-ic" aria-hidden="true">{{ n.kind === 'success' ? '✓' : n.kind === 'info' ? 'i' : '!' }}</span>
        <span class="nt-text">{{ n.text }}</span>
        <button
          type="button"
          class="nt-close"
          :aria-label="t('common.close')"
          :title="t('common.close')"
          @click="dismissNotification(n.id)"
        >
          ×
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
@import '../styles/tokens.css';

.nhost {
  position: fixed;
  /* Pinned to the bottom edge (same margin as the reconnect toast); the
     column grows upward from here. */
  bottom: 20px;
  left: 20px;
  z-index: 1002;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(420px, 92vw);
  pointer-events: none;
  /* The drawer animates width 0.33 s cubic-bezier(0.16,1,0.3,1); the stack
     follows the content column with the same curve. */
  transition: left 0.33s cubic-bezier(0.16, 1, 0.3, 1);
}

.nt {
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 12px 30px 11px 12px;
  background: var(--ui-surface);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-shadow-md);
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1.45;
  color: var(--ui-text);
  white-space: pre-line;
  pointer-events: auto;
  overflow: hidden;
}

/* Countdown bar on the top edge: shrinks 100% → 0% over the item's durationMs. */
.nt-timer {
  position: absolute;
  top: 0;
  left: 0;
  height: 3px;
  border-radius: 0 3px 0 0;
  animation: nt-shrink linear forwards;
}

.nt--error .nt-timer {
  background: var(--ui-danger);
}

.nt--success .nt-timer {
  background: var(--ui-success);
}

.nt--info .nt-timer {
  background: var(--ui-accent);
}

@keyframes nt-shrink {
  from { width: 100%; }
  to { width: 0%; }
}

.nt-ic {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 800;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 1px;
}

.nt--error .nt-ic {
  background: color-mix(in srgb, var(--ui-danger) 14%, transparent);
  color: var(--ui-danger);
}

.nt--success .nt-ic {
  background: color-mix(in srgb, var(--ui-success) 14%, transparent);
  color: var(--ui-success);
}

.nt--info .nt-ic {
  background: color-mix(in srgb, var(--ui-accent) 14%, transparent);
  color: var(--ui-accent);
}

.nt-text {
  min-width: 0;
  word-break: break-word;
}

.nt-close {
  position: absolute;
  top: 4px;
  right: 8px;
  background: transparent;
  border: none;
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  line-height: 1;
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
}

.nt-close:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}

.nt-fade-enter-active,
.nt-fade-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.nt-fade-enter-from,
.nt-fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}

@media (prefers-reduced-motion: reduce) {
  .nt-fade-enter-active,
  .nt-fade-leave-active {
    transition: none;
  }
}
</style>