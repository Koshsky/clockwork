<script setup lang="ts">
import { useModalFocus } from '../../../composables/useModalFocus'
import CopyField from '../CopyField/CopyField.vue'
import { t } from '../../../i18n'
import type { PasswordDialogProps } from './types'

const props = withDefaults(defineProps<PasswordDialogProps>(), {
  open: false,
})

const emit = defineEmits<{
  close: []
}>()

// Initial focus, Tab trap and Escape all come from the shared modal helper:
// the dialog is teleported to <body>, so an overlay-scoped keydown listener
// would never see the keys pressed while focus sits outside the card.
const { dialogEl, onKeydown } = useModalFocus({
  open: () => props.open,
  onClose: () => emit('close'),
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pd-overlay" @mousedown.self="emit('close')">
      <div ref="dialogEl" class="pd-card" role="dialog" aria-modal="true" :aria-label="caption" tabindex="-1" @keydown="onKeydown">
        <div class="pd-caption">{{ caption }}</div>
        <CopyField v-if="password" :value="password" />
        <p v-else-if="notice" class="pd-note">{{ notice }}</p>
        <p v-if="password" class="pd-note">{{ t('ui.password.dialogShownOnce') }}</p>
        <button type="button" class="pd-close" @click="emit('close')">{{ t('common.close') }}</button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
@import '../../../styles/tokens.css';

/* Overlays sit above the app header (z 30000), like the other modals */
.pd-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  z-index: 40000;
  display: flex;
  align-items: center;
  justify-content: center;
}
.pd-card {
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  padding: 24px;
  width: 420px;
  max-width: calc(100vw - 32px);
  box-shadow: var(--ui-shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.pd-caption {
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: var(--ui-text);
}
.pd-note {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-muted);
  margin: 0;
}
.pd-close {
  border: none;
  border-radius: var(--ui-radius-sm);
  padding: 9px;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-weight: 600;
  cursor: pointer;
  background: var(--ui-accent);
  color: var(--ui-accent-on);
}
.pd-close:hover {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
</style>