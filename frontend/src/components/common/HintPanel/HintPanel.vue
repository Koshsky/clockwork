<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute } from 'vue-router'
import { closeHints, hintOpen, hintPageContent } from '@/composables/useHints'
import { useModalFocus } from '@/composables/useModalFocus'
import MarkdownView from '../MarkdownView/MarkdownView.vue'
import { t } from '../../../i18n'

defineOptions({ name: 'HintPanel' })

const route = useRoute()

const { dialogEl, onKeydown } = useModalFocus({
  open: () => hintOpen.value,
  onClose: () => closeHints(),
})

// A hint belongs to the page it was opened on: navigating away closes it.
let stopRouteWatch: (() => void) | undefined
onMounted(() => {
  stopRouteWatch = watch(
    () => route.fullPath,
    () => closeHints(),
  )
})
onBeforeUnmount(() => stopRouteWatch?.())
</script>

<template>
  <Teleport to="body">
    <!-- Входной и выходной слайд-фейд одинаковые: закрытие так же плавно,
         как открытие (0.22s ease-out). -->
    <Transition name="hp">
      <div v-if="hintOpen && hintPageContent" class="hp-overlay" @mousedown.self="closeHints">
        <div
          ref="dialogEl"
          class="hp-panel"
          role="dialog"
          aria-modal="true"
          :aria-label="hintPageContent.title"
          tabindex="-1"
          @keydown="onKeydown"
        >
          <div class="hp-head">
            <h3 class="hp-title">{{ hintPageContent.title }}</h3>
            <button type="button" class="hp-close" :aria-label="t('ui.hint.close')" @click="closeHints">✕</button>
          </div>

          <div class="hp-body">
            <MarkdownView :source="hintPageContent.body" />
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
@import "../../../styles/tokens.css";
.hp-overlay {
  position: fixed;
  inset: 0;
  /* Below the modal layer (ModalForm): a modal stays readable above the hint */
  z-index: 30000;
  display: flex;
  justify-content: flex-end;
  background: rgba(0, 0, 0, 0.4);
}
.hp-panel {
  width: min(660px, 96vw);
  height: 100%;
  background: var(--ui-surface);
  color: var(--ui-text);
  box-shadow: var(--ui-shadow-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: transform 0.22s ease-out, opacity 0.22s ease-out;
}
/* Вход и выход симметричны: скрим плавно гаснет, панель уезжает вправо */
.hp-enter-active,
.hp-leave-active {
  transition: opacity 0.22s ease-out;
}
.hp-enter-from,
.hp-leave-to {
  opacity: 0;
}
.hp-enter-from .hp-panel,
.hp-leave-to .hp-panel {
  transform: translateX(24px);
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .hp-enter-active,
  .hp-leave-active,
  .hp-panel {
    transition: none;
  }
}
.hp-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--ui-border);
  flex-shrink: 0;
}
.hp-title {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 19px);
  font-weight: 700;
  color: var(--ui-text);
}
.hp-close {
  border: none;
  background: transparent;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  line-height: 1;
  color: var(--ui-text-muted);
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
}
.hp-close:hover {
  background: var(--ui-surface-2);
  color: var(--ui-text);
}
.hp-body {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px;
}
.hp-done:hover {
  background: color-mix(in srgb, var(--ui-accent) 88%, black);
}
</style>