<script setup lang="ts">
import { computed } from 'vue'
import { t } from '@/i18n'
import { useModalFocus } from '@/composables/useModalFocus'
import { nativeDiagnosticsOpen, nativeDiagnosticReport, nativeDiagnosticState, closeNativeDiagnostics, openNativeDiagnostics, saveNativeDiagnostics } from './native'
const report = computed(() => nativeDiagnosticReport.value ? JSON.stringify(nativeDiagnosticReport.value, null, 2) : '')
const { dialogEl, onKeydown } = useModalFocus({ open: () => nativeDiagnosticsOpen.value, onClose: closeNativeDiagnostics })
</script>
<template>
  <Teleport to="body">
    <div v-if="nativeDiagnosticsOpen" class="ndg-overlay" @mousedown.self="closeNativeDiagnostics">
      <section ref="dialogEl" class="ndg-card" role="dialog" aria-modal="true" :aria-label="t('diagnostics.title')" tabindex="-1" @keydown="onKeydown">
        <h2>{{ t('diagnostics.title') }}</h2>
        <p>{{ t('diagnostics.native.privacy') }}</p>
        <p v-if="nativeDiagnosticReport">{{ t('diagnostics.versions', { frontend: nativeDiagnosticReport.frontend_version, backend: nativeDiagnosticReport.backend_version }) }}</p>
        <p v-if="nativeDiagnosticReport?.state.queue">{{ t('diagnostics.native.queue', { pending: nativeDiagnosticReport.state.queue.pending, ready: nativeDiagnosticReport.state.queue.ready, blocked: nativeDiagnosticReport.state.queue.blocked, conflict: nativeDiagnosticReport.state.queue.conflict, rejected: nativeDiagnosticReport.state.queue.rejected }) }}</p>
        <p v-if="nativeDiagnosticState === 'loading'" role="status">{{ t('diagnostics.native.loading') }}</p>
        <p v-if="nativeDiagnosticState === 'failed'" role="status">{{ t('diagnostics.native.failed') }}</p>
        <p v-if="nativeDiagnosticState === 'saved'" role="status">{{ t('diagnostics.native.saved') }}</p>
        <label for="native-diagnostic-report">{{ t('diagnostics.preview') }}</label>
        <textarea id="native-diagnostic-report" :value="report" readonly spellcheck="false" />
        <footer>
          <button type="button" :disabled="nativeDiagnosticState === 'loading' || nativeDiagnosticState === 'saving'" @click="openNativeDiagnostics">{{ t('diagnostics.native.refresh') }}</button>
          <button type="button" class="ndg-primary" :disabled="!nativeDiagnosticReport || nativeDiagnosticState === 'saving' || nativeDiagnosticState === 'loading'" @click="saveNativeDiagnostics">{{ t('diagnostics.native.save') }}</button>
          <button type="button" @click="closeNativeDiagnostics">{{ t('common.close') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>
<style scoped>
.ndg-overlay { position: fixed; inset: 0; z-index: var(--z-diagnostics); display: grid; place-items: center; background: rgb(0 0 0 / 40%); padding: 20px; }
.ndg-card { width: min(720px, 100%); max-height: 90dvh; overflow: auto; display: grid; gap: 14px; padding: 24px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); color: var(--ui-text); box-shadow: var(--ui-shadow-lg); font-size: 13px; }
.ndg-card h2 { font-size: 18px; }
.ndg-card p { color: var(--ui-text-muted); }
.ndg-card textarea { width: 100%; min-height: 280px; resize: vertical; padding: 12px; background: var(--ui-surface-2); color: var(--ui-text); border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); font: 12px/1.5 monospace; }
.ndg-card footer { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; }
.ndg-card button { border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); background: var(--ui-surface-2); color: var(--ui-text); padding: 8px 12px; cursor: pointer; }
.ndg-card button:disabled { opacity: .5; cursor: default; }
.ndg-card .ndg-primary { background: var(--ui-accent); color: var(--ui-accent-on); }
.ndg-card button:focus-visible, .ndg-card textarea:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
@media print { .ndg-overlay { display: none; } }
</style>
