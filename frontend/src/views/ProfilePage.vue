<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { useAuthStore, useRbacStore } from '../store'
import { isOffline } from '@/store/data/uiServices'
import { loadAppManifest } from '@/store/data/pageReads'
import { t } from '../i18n'
import { fullName } from '../utils/fullName'
import { presetLabelFromCatalog } from '../utils/presets'
import ProfileEditPage from './ProfileEditPage.vue'

const auth = useAuthStore()
const rbac = useRbacStore()
const route = useRoute()

const sections = computed(() => [
  { id: 'data', label: t('adminUsers.profile.section.data') },
  { id: 'security', label: t('adminUsers.profile.section.security') },
  { id: 'about', label: t('adminUsers.profile.section.about') },
])
const activeSection = computed(() =>
  sections.value.some((section) => section.id === route.query.section) ? route.query.section : 'data',
)
const displayName = computed(() => fullName(auth.user).trim() || auth.user?.name?.trim() || auth.user?.username || '—')
const headingName = computed(() =>
  [auth.user?.first_name?.trim(), auth.user?.last_name?.trim()].filter(Boolean).join(' ') || displayName.value,
)
const initials = computed(() =>
  headingName.value.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => [...part][0]).join('').toUpperCase(),
)
const presetLabel = computed(() => presetLabelFromCatalog(auth.user?.preset, rbac.presets))
const connectionLabel = computed(() =>
  isOffline.value ? t('adminUsers.profile.offline') : t('adminUsers.profile.online'),
)
const appBuildVersion = __APP_VERSION__
const appVersion = ref('—')

async function refreshAppInfo() {
  try {
    const data = await loadAppManifest()
    if (data) {
      appVersion.value = data.version ?? '—'
    }
  } catch {
    // An unavailable manifest must not prevent access to account settings.
  }
}

onMounted(() => {
  const id = auth.user?.id
  if (id != null) void auth.fetchProfile(id)
  if (!isOffline.value) void rbac.ensurePresets()
  void refreshAppInfo()
})
</script>

<template>
  <section class="pf" aria-labelledby="profile-title">
    <h2 id="profile-title" class="pf-title">{{ t('adminUsers.profile.title') }}</h2>
    <div class="pf-layout">
      <nav class="pf-nav" :aria-label="t('adminUsers.profile.navigation')">
        <RouterLink
          v-for="section in sections"
          :key="section.id"
          :to="{ name: 'profile', query: { section: section.id } }"
          class="pf-nav-link"
          :class="{ active: activeSection === section.id }"
          :aria-current="activeSection === section.id ? 'page' : undefined"
        >{{ section.label }}</RouterLink>
      </nav>

      <div class="pf-card">
        <section v-if="activeSection === 'data'" class="pf-panel" aria-labelledby="profile-data-title">
          <div class="pf-identity">
            <div class="pf-avatar" aria-hidden="true">{{ initials }}</div>
            <div class="pf-person">
              <h3 class="pf-name">{{ headingName }}</h3>
              <p class="pf-login">{{ auth.user?.username ? `@${auth.user.username}` : '—' }}</p>
            </div>
          </div>
          <h3 id="profile-data-title" class="pf-section-title">{{ t('adminUsers.profile.section.data') }}</h3>
          <dl class="pf-fields">
            <div><dt>{{ t('adminUsers.profile.field.name') }}</dt><dd>{{ displayName }}</dd></div>
            <div><dt>{{ t('adminUsers.profile.field.login') }}</dt><dd>{{ auth.user?.username || '—' }}</dd></div>
            <div><dt>{{ t('adminUsers.profile.field.preset') }}</dt><dd>{{ presetLabel }}</dd></div>
          </dl>
        </section>

        <section v-else-if="activeSection === 'security'" class="pf-panel" aria-labelledby="profile-security-title">
          <h3 id="profile-security-title" class="pf-section-title">{{ t('adminUsers.profile.section.security') }}</h3>
          <ProfileEditPage embedded />
        </section>

        <section v-else class="pf-panel" aria-labelledby="profile-about-title">
          <h3 id="profile-about-title" class="pf-section-title">{{ t('adminUsers.profile.section.about') }}</h3>
          <dl class="pf-fields">
            <div>
              <dt>{{ t('adminUsers.profile.field.state') }}</dt>
              <dd class="pf-connection" :class="isOffline ? 'off' : 'on'" role="status">
                <span class="pf-dot" aria-hidden="true"></span>{{ connectionLabel }}
              </dd>
            </div>
            <div><dt>{{ t('adminUsers.profile.field.appVersion') }}</dt><dd class="pf-version">{{ appVersion }}</dd></div>
            <div><dt>{{ t('adminUsers.profile.field.buildVersion') }}</dt><dd class="pf-version">{{ appBuildVersion }}</dd></div>
            <div><dt>{{ t('adminUsers.profile.field.id') }}</dt><dd>{{ auth.user?.id ?? '—' }}</dd></div>
          </dl>
        </section>
      </div>
    </div>
  </section>
</template>

<style scoped>
@import '../styles/tokens.css';

.pf { max-width: 900px; }
.pf-title {
  margin: 0 0 24px;
  font-size: calc(var(--ui-font-scale, 1) * 24px);
  font-weight: 700;
  color: var(--ui-text);
}
.pf-layout { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 24px; align-items: start; }
.pf-nav { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.pf-nav-link {
  padding: 11px 14px;
  border-radius: var(--ui-radius-sm);
  color: var(--ui-text-muted);
  text-decoration: none;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  overflow-wrap: anywhere;
  transition: background var(--ui-duration), color var(--ui-duration);
}
.pf-nav-link:hover { background: var(--ui-surface-3); color: var(--ui-text); }
.pf-nav-link.active { background: var(--ui-accent-soft); color: var(--ui-accent); font-weight: 600; }
.pf-card {
  min-width: 0;
  background: var(--ui-surface);
  border-radius: var(--ui-radius-md);
  box-shadow: var(--ui-shadow-sm);
}
.pf-panel { min-height: 390px; padding: 24px; }
.pf-identity {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 24px;
  margin-bottom: 24px;
  border-bottom: 1px solid var(--ui-border);
}
.pf-avatar {
  display: grid;
  place-items: center;
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-size: calc(var(--ui-font-scale, 1) * 18px);
  font-weight: 600;
}
.pf-person { min-width: 0; }
.pf-name { margin: 0; font-size: calc(var(--ui-font-scale, 1) * 18px); font-weight: 600; color: var(--ui-text); overflow-wrap: anywhere; }
.pf-login { margin: 4px 0 0; font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-muted); overflow-wrap: anywhere; }
.pf-section-title { margin: 0; font-size: calc(var(--ui-font-scale, 1) * 16px); font-weight: 600; color: var(--ui-text); }
.pf-fields { display: grid; gap: 22px; margin: 24px 0 0; font-size: calc(var(--ui-font-scale, 1) * 14px); }
.pf-fields dt { margin-bottom: 6px; color: var(--ui-text-muted); font-size: calc(var(--ui-font-scale, 1) * 13px); }
.pf-fields dd { margin: 0; color: var(--ui-text); font-weight: 500; overflow-wrap: anywhere; }
.pf-version { font-family: var(--ui-font-mono, monospace); }
.pf-connection { display: flex; align-items: center; gap: 8px; }
.pf-connection.on { color: var(--ui-success); }
.pf-connection.off { color: var(--ui-warning); }
.pf-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
@media (max-width: 640px) {
  .pf-layout { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .pf-nav { flex-direction: row; flex-wrap: wrap; gap: 4px; }
  .pf-nav-link { padding: 10px 12px; }
  .pf-panel { padding: 20px; }
}
</style>
