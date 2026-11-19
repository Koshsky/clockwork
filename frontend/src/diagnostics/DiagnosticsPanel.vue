<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { AppIcon } from '@/components/common/AppIcon'
import { useModalFocus } from '@/composables/useModalFocus'
import { t } from '@/i18n'
import { fmtDateTime } from '@/i18n/date'
import { diagnosticsOpen, webDiagnostics } from './web'

const copyState = ref<'idle' | 'copied' | 'failed'>('idle')
const report = computed(() => webDiagnostics.report())
const { dialogEl, onKeydown } = useModalFocus({ open: () => diagnosticsOpen.value, onClose: close })
function close() { diagnosticsOpen.value = false }
watch([diagnosticsOpen, report], () => { copyState.value = 'idle' })
async function copy() {
  const text = report.value, context = webDiagnostics.contextToken()
  try {
    await navigator.clipboard.writeText(text)
    if (context === webDiagnostics.contextToken() && diagnosticsOpen.value && text === report.value) copyState.value = 'copied'
  } catch {
    if (context === webDiagnostics.contextToken() && diagnosticsOpen.value && text === report.value) copyState.value = 'failed'
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="diagnosticsOpen" class="wd-overlay" @mousedown.self="close">
      <section ref="dialogEl" class="wd-card" role="dialog" aria-modal="true" :aria-label="t('diagnostics.title')" tabindex="-1" @keydown="onKeydown">
        <header class="wd-head">
          <h2>{{ t('diagnostics.title') }}</h2>
          <button type="button" :aria-label="t('common.close')" @click="close"><AppIcon name="close" :size="18" /></button>
        </header>
        <div class="wd-body">
          <p>{{ t('diagnostics.privacy') }}</p>
          <p>{{ t('diagnostics.versions', { frontend: webDiagnostics.snapshot().frontend_version, backend: webDiagnostics.backendVersion.value ?? t('diagnostics.unknown') }) }}</p>
          <p v-if="!webDiagnostics.records.value.length" role="status">{{ t('diagnostics.empty') }}</p>
          <ol v-else class="wd-records">
            <li v-for="(entry, index) in webDiagnostics.records.value" :key="index">
              <div><strong>{{ t(`diagnostics.failure.${entry.failure}`) }}</strong><span>{{ t('diagnostics.count', { count: entry.count }) }}</span></div>
              <div><code>{{ entry.diagnostic.error_code }}</code><span v-if="entry.diagnostic.status">HTTP {{ entry.diagnostic.status }}</span><time>{{ fmtDateTime(entry.last_seen) }}</time></div>
              <code v-if="entry.diagnostic.request_id">{{ t('diagnostics.requestId') }}: {{ entry.diagnostic.request_id }}</code>
            </li>
          </ol>
          <label for="web-diagnostic-report">{{ t('diagnostics.preview') }}</label>
          <textarea id="web-diagnostic-report" :value="report" readonly spellcheck="false" />
          <p v-if="copyState !== 'idle'" role="status">{{ t(copyState === 'copied' ? 'diagnostics.copied' : 'diagnostics.copyFailed') }}</p>
        </div>
        <footer class="wd-actions">
          <button type="button" :disabled="!webDiagnostics.records.value.length" @click="webDiagnostics.clear()">{{ t('diagnostics.clear') }}</button>
          <button type="button" class="wd-primary" @click="copy">{{ t('diagnostics.copy') }}</button>
          <button type="button" @click="close">{{ t('common.close') }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.wd-overlay { position: fixed; inset: 0; z-index: var(--z-diagnostics); display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 40%); }
.wd-card { width: min(680px, 100%); max-height: 90dvh; display: flex; flex-direction: column; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-lg); background: var(--ui-surface); color: var(--ui-text); box-shadow: var(--ui-shadow-lg); }
.wd-head, .wd-actions { display: flex; align-items: center; gap: 12px; padding: 16px 20px; }
.wd-head { justify-content: space-between; border-bottom: 1px solid var(--ui-border); }
.wd-head h2 { font-size: 18px; }
.wd-body { overflow: auto; padding: 20px; display: grid; gap: 14px; font-size: 13px; }
.wd-body p { color: var(--ui-text-muted); }
.wd-records { list-style: none; display: grid; gap: 10px; max-height: 220px; overflow: auto; }
.wd-records li { padding: 10px; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); overflow-wrap: anywhere; }
.wd-records li div { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.wd-body textarea { width: 100%; min-height: 150px; resize: vertical; border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); padding: 10px; background: var(--ui-surface-2); color: var(--ui-text); font: 12px/1.5 monospace; }
.wd-actions { justify-content: flex-end; flex-wrap: wrap; border-top: 1px solid var(--ui-border); }
button { border: 1px solid var(--ui-border); border-radius: var(--ui-radius-sm); background: var(--ui-surface-2); color: var(--ui-text); padding: 8px 12px; cursor: pointer; }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible, textarea:focus-visible { outline: 2px solid var(--ui-accent); outline-offset: 2px; }
.wd-primary { background: var(--ui-accent); color: var(--ui-accent-on); border-color: var(--ui-accent); }
@media print { .wd-overlay { display: none; } }
</style>
