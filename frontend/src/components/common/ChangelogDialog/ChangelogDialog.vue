<script setup lang="ts">
/**
 * ChangelogDialog: the changelog of the ACTIVE interface language
 * (Changelog_RU.md or Changelog_ENG.md — the pair maintained with every
 * release) rendered through the shared MarkdownView in a centered modal:
 * rounded corners, header with title and ✕, and a vertically scrolling body.
 * Opened from the header icon. Both files are bundled as raw text; the switch
 * is reactive, so a language change re-renders the open dialog.
 */
import { computed } from 'vue'
import changelogEn from '../../../../Changelog_ENG.md?raw'
import changelogRu from '../../../../Changelog_RU.md?raw'
import { MarkdownView } from '../MarkdownView'
import { AppIcon } from '../AppIcon'
import { appLocale, t } from '../../../i18n'
import { useModalFocus } from '../../../composables/useModalFocus'
import type { ChangelogDialogProps, ChangelogDialogEmits } from './types'

const props = defineProps<ChangelogDialogProps>()
const emit = defineEmits<ChangelogDialogEmits>()

const appVersion = __APP_VERSION__

/** Changelog text of the interface language (fallback: Russian). */
const changelogSource = computed(() => (appLocale.value === 'en' ? changelogEn : changelogRu))

const { dialogEl, onKeydown } = useModalFocus({
  open: () => props.open,
  onClose: () => emit('close'),
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="cdlg-overlay" @mousedown.self="emit('close')">
      <div
        ref="dialogEl"
        class="cdlg-card"
        role="dialog"
        aria-modal="true"
        :aria-label="t('changelog.title')"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header class="cdlg-head">
          <span class="cdlg-head-ic" aria-hidden="true">
            <AppIcon name="scroll" :size="18" />
          </span>
          <div class="cdlg-head-text">
            <h3 class="cdlg-title">{{ t('changelog.title') }}</h3>
            <span class="cdlg-version">{{ t('changelog.currentVersion') }} {{ appVersion }}</span>
          </div>
          <button type="button" class="cdlg-close" :aria-label="t('common.close')" :title="t('common.close')" @click="emit('close')">✕</button>
        </header>
        <div class="cdlg-body">
          <MarkdownView :source="changelogSource" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
@import '../../../styles/tokens.css';

/* Centered modal backdrop: full-screen dim under the changelog card */
.cdlg-overlay {
  position: fixed;
  inset: 0;
  z-index: 31000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.4);
}

.cdlg-card {
  display: flex;
  flex-direction: column;
  width: min(700px, 92vw);
  max-height: 82vh;
  background: var(--ui-surface);
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  box-shadow: var(--ui-shadow-lg);
  overflow: hidden;
}

.cdlg-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  background: var(--ui-surface-2);
  border-bottom: 1px solid var(--ui-border);
  flex: none;
}

.cdlg-head-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  flex: none;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
}

.cdlg-head-text {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.cdlg-title {
  margin: 0;
  font-size: calc(var(--ui-font-scale, 1) * 16px);
  font-weight: 700;
  color: var(--ui-text);
}

.cdlg-version {
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  color: var(--ui-text-2);
}

.cdlg-close {
  border: none;
  background: transparent;
  color: var(--ui-text-2);
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  line-height: 1;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--ui-radius-sm);
  transition: background var(--ui-duration), color var(--ui-duration);
}

.cdlg-close:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}

/* Vertically scrolling body: the changelog content lives here */
.cdlg-body {
  flex: 1;
  overflow-y: auto;
  padding: 22px 26px 30px;
}

.cdlg-body :deep(.mdv) {
  font-size: calc(var(--ui-font-scale, 1) * 15px);
}

/* Release headings: large, with an accent underline */
.cdlg-body :deep(.mdv h2) {
  margin: 36px 0 6px;
  padding-bottom: 10px;
  font-size: calc(var(--ui-font-scale, 1) * 21px);
  font-weight: 700;
  color: var(--ui-text);
  border-bottom: 2px solid var(--ui-accent-soft);
}

.cdlg-body :deep(.mdv h2:first-child) {
  margin-top: 4px;
}

/* Change-type sections (### Изменено / Исправлено / …): small caps accent */
.cdlg-body :deep(.mdv h3) {
  margin: 24px 0 8px;
  font-size: calc(var(--ui-font-scale, 1) * 12px);
  font-weight: 700;
  letter-spacing: 0.6px;
  text-transform: uppercase;
  color: var(--ui-accent);
}

.cdlg-body :deep(.mdv li) {
  margin-bottom: 7px;
  line-height: 1.55;
  color: var(--ui-text);
}
</style>