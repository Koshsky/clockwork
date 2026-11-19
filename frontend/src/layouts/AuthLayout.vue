<script setup lang="ts">
import { openDiagnostics } from '@/diagnostics/web'
import { platformCapabilities } from '@/platform/context'
import { t } from '@/i18n'
</script>

<template>
  <div class="al">
    <RouterView />
    <button v-if="platformCapabilities.kind === 'web'" class="al-diagnostics" type="button" @click="openDiagnostics">{{ t('diagnostics.title') }}</button>
  </div>
</template>

<style scoped>
@import '../styles/tokens.css';

.al-diagnostics { border: 1px solid currentColor; border-radius: var(--ui-radius-sm); padding: 8px 12px; background: transparent; color: var(--ui-accent-on); cursor: pointer; }

.al {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background:
    radial-gradient(circle at 15% 20%, color-mix(in srgb, var(--ui-accent-on) 14%, transparent), transparent 35%),
    radial-gradient(circle at 85% 80%, color-mix(in srgb, var(--ui-accent-on) 12%, transparent), transparent 40%),
    var(--ui-accent);
  overflow: hidden;
}
</style>

