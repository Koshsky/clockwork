<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '../../../store'
import { resolvedScheme, toggleScheme } from '../../../theme'
import { isNavOpen, toggleNav } from '../../../composables/useNavDrawer'
import { AppIcon } from '../AppIcon'
import { ChangelogDialog } from '../ChangelogDialog'
import { appLocale, t } from '../../../i18n'
import { uiLanguage } from '../../../settings'

const router = useRouter()
const route = useRoute()
const authStore = useAuthStore()

// Theme toggle label (the switch shows the scheme it will move to)
const themeLabel = computed(() => t(resolvedScheme.value === 'dark' ? 'header.themeDark' : 'header.themeLight'))
const themeToggleTitle = computed(() => t('header.themeToggle', { theme: themeLabel.value }))

/** Name of the language the interface is rendered in (for the tooltip). */
const langLabel = computed(() => t(appLocale.value === 'ru' ? 'header.langRu' : 'header.langEn'))
const langToggleTitle = computed(() => t('header.languageToggle', { language: langLabel.value }))

/**
 * Language toggle — a plain switch like the theme toggle: only two languages
 * are available, so the button flips to the other one. The first flip leaves
 * the "system" mode of the Settings select and pins an explicit language.
 */
function toggleLanguage(): void {
  uiLanguage.value = appLocale.value === 'ru' ? 'en' : 'ru'
}

/** Whether the centered changelog dialog is visible (header icon) */
const changelogOpen = ref(false)

function onLogout(): void {
  authStore.logout()
  router.push('/login')
}

const burgerTitle = computed(() => t('header.menuShortcut'))
const burgerLabel = computed(() => (isNavOpen.value ? t('header.menuClose') : t('header.menuOpen')))
</script>

<template>
  <header class="ah">
    <!-- Burger: a single glyph that morphs between the hamburger (drawer
         closed) and an × (drawer visible) — the three bars rotate into the
         cross with a smooth transition -->
    <button
      type="button"
      class="ah-burger"
      :aria-label="burgerLabel"
      :aria-expanded="isNavOpen"
      :title="burgerTitle"
      @click="toggleNav"
    >
      <span class="ah-burger-glyph" :class="{ open: isNavOpen }" aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          width="22"
          height="22"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line class="ah-line ah-line--top" x1="4" y1="6" x2="20" y2="6" />
          <line class="ah-line ah-line--mid" x1="4" y1="12" x2="20" y2="12" />
          <line class="ah-line ah-line--bot" x1="4" y1="18" x2="20" y2="18" />
        </svg>
      </span>
    </button>

    <div class="ah-spacer"></div>

    <div class="ah-actions">
      <RouterLink to="/profile" class="ah-act" :class="{ active: route.name === 'profile' }">
        <AppIcon name="user" :size="18" />
        <span>{{ t('header.profile') }}</span>
      </RouterLink>
      <button
        type="button"
        class="ah-act ah-act--icon"
        :title="themeToggleTitle"
        :aria-label="t('header.themeAria')"
        @click="toggleScheme"
      >
        <AppIcon :name="resolvedScheme === 'dark' ? 'sun' : 'moon'" :size="18" />
      </button>
      <button
        type="button"
        class="ah-act ah-act--icon"
        :title="langToggleTitle"
        :aria-label="t('header.languageAria')"
        @click="toggleLanguage"
      >
        <AppIcon name="languages" :size="18" />
      </button>
      <button
        type="button"
        class="ah-act ah-act--icon"
        :title="t('header.changelog')"
        :aria-label="t('header.changelog')"
        @click="changelogOpen = true"
      >
        <AppIcon name="scroll" :size="18" />
      </button>
      <button
        type="button"
        class="ah-act ah-act--icon ah-act--logout"
        :title="t('header.logout')"
        :aria-label="t('header.logout')"
        @click="onLogout"
      >
        <AppIcon name="logout" :size="18" />
      </button>
    </div>

    <ChangelogDialog :open="changelogOpen" @close="changelogOpen = false" />
  </header>
</template>

<style scoped>
@import '../../../styles/tokens.css';

.ah {
  width: 100%; /* the header width never depends on the page or scrollbars */
  /* The header is a flex item of .ml-col (column flex): without this the flex
     shrink distribution on viewport-filling diagram pages squeezes the header
     height below 60px (the timeline is taller than the container). flex: none
     keeps the header size dependent only on the screen, never on page content. */
  flex: none;
  background: var(--ui-surface);
  color: var(--ui-text);
  padding: 0 16px 0 8px;
  height: 60px;
  display: flex;
  align-items: center;
  gap: 12px;
  box-shadow: var(--ui-shadow-sm);
  border-bottom: 1px solid var(--ui-border);
  position: sticky;
  top: 0;
  z-index: 100; /* above page content inside the column */
}

.ah-burger {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-2);
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration);
}

.ah-burger:hover {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}

.ah-burger:focus-visible {
  outline: 2px solid var(--ui-focus);
  outline-offset: 2px;
}

/* Morphing burger glyph — universal (works in Chromium, Firefox, Safari).
   One SVG whose three bars transform into a full centred ×:
   - top/bottom bars slide to the middle line (translateY) and tilt ±45°
     around the canvas centre (transform-box: view-box → origin 12,12);
   - the middle bar fades out.
   Function order matters: `rotate(45deg) translateY(6px)` applies the
   translate FIRST (bar reaches the centre line) and the rotate LAST,
   yielding a proper centred diagonal. */
.ah-burger-glyph {
  display: block;
  width: 22px;
  height: 22px;
}

.ah-line {
  transform-box: view-box;
  transform-origin: center;
  transition:
    transform 0.34s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.22s ease;
}

.ah-burger-glyph.open .ah-line--top {
  transform: rotate(45deg) translateY(6px);
}

.ah-burger-glyph.open .ah-line--mid {
  opacity: 0;
}

.ah-burger-glyph.open .ah-line--bot {
  transform: rotate(-45deg) translateY(-6px);
}

.ah-spacer {
  flex: 1;
}

.ah-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.ah-act {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 42px;
  padding: 0 14px;
  border: none;
  border-radius: var(--ui-radius-sm);
  background: transparent;
  color: var(--ui-text-2);
  text-decoration: none;
  font-size: calc(var(--ui-font-scale, 1) * 14px);
  font-family: inherit;
  cursor: pointer;
  transition: background var(--ui-duration), color var(--ui-duration);
}

.ah-act:hover:not(:disabled) {
  background: var(--ui-surface-3);
  color: var(--ui-text);
}

.ah-act.active {
  background: var(--ui-accent-soft);
  color: var(--ui-accent);
  font-weight: 600;
}

/* Icon-only actions (theme toggle, logout): square, no label */
.ah-act--icon {
  width: 42px;
  padding: 0;
  justify-content: center;
}

.ah-act--logout:hover:not(:disabled) {
  background: var(--ui-danger-soft);
  border-color: var(--ui-danger);
  color: var(--ui-danger);
}

.ah-act:disabled {
  opacity: 0.45;
  cursor: not-allowed;
  pointer-events: none;
}

/* Narrow screens: one row, icons only (touch targets stay >= 44px) */
@media (max-width: 720px) {
  .ah {
    padding: 0 8px;
    gap: 4px;
  }

  .ah-act {
    width: 48px;
    padding: 0;
    justify-content: center;
  }

  .ah-act span {
    display: none;
  }

  .ah-actions {
    gap: 2px;
  }
}
</style>