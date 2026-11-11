<script setup lang="ts">
import { useModalFocus } from '../../../composables/useModalFocus'
import { t } from '../../../i18n'
import type { ConfirmDialogProps } from './types'

const props = withDefaults(defineProps<ConfirmDialogProps>(), {
  title: '',
  confirmLabel: '',
  danger: true,
})

const emit = defineEmits<{
  confirm: []
  close: []
}>()

/**
 * Focus management: initial focus, Tab trap, Escape from anywhere and focus
 * restore. The previous document listener had no `open` guard, so Escape was
 * handled even while the dialog was closed — a hidden dialog could swallow or
 * double-close a parent modal.
 */
const { dialogEl, onKeydown } = useModalFocus({
  open: () => props.open,
  onClose: () => emit('close'),
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cd-overlay" @mousedown.self="emit('close')">
      <div ref="dialogEl" class="cd" role="dialog" aria-modal="true" :aria-label="title || t('common.confirmTitle')" tabindex="-1" @keydown="onKeydown">
        <div class="cd-head">
          <h3 class="cd-title">{{ title || t('common.confirmTitle') }}</h3>
          <button type="button" class="cd-close" :aria-label="t('common.close')" @click="emit('close')">×</button>
        </div>
        <p class="cd-message">{{ message }}</p>
        <div class="cd-actions">
          <button type="button" class="cd-btn cd-cancel" @click="emit('close')">{{ t('common.cancel') }}</button>
          <button
            type="button"
            class="cd-btn"
            :class="danger ? 'cd-danger' : 'cd-primary'"
            @click="emit('confirm')"
          >
            {{ confirmLabel || t('common.delete') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
@import "../../../styles/tokens.css";

.cd-overlay {
  position: fixed;
  inset: 0;
  /* Confirmation dialog renders above all page overlays (modals, menus) */
  z-index: 50000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
  padding: 16px;
}
.cd {
  width: 100%;
  max-width: 400px;
  background: var(--ui-surface);
  border-radius: 10px;
  box-shadow: var(--ui-shadow-md);
  overflow: hidden;
}
.cd-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ui-border);
}
.cd-title {
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: var(--ui-text);
  margin: 0;
}
.cd-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 22px);
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 6px;
}
.cd-close:hover {
  background: var(--ui-surface-2);
  color: var(--ui-text);
}
.cd-message {
  margin: 0;
  padding: 18px 16px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1.5;
  color: var(--ui-text-2);
}
.cd-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 16px 16px;
}
.cd-btn {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px 18px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--ui-duration), opacity var(--ui-duration);
}
.cd-cancel {
  background: var(--ui-surface-2);
  color: var(--ui-text-2);
}
.cd-cancel:hover {
  background: var(--ui-border);
}
.cd-primary {
  background: var(--ui-accent);
  color: var(--ui-accent-on);
}
.cd-primary:hover {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
.cd-danger {
  background: var(--ui-danger);
  color: var(--ui-accent-on);
}
.cd-danger:hover {
  background: color-mix(in srgb, var(--ui-danger) 88%, black);
}
</style>
