<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import ReconnectToast from './offline/ReconnectToast.vue'
import SyncToast from './offline/SyncToast.vue'
import NotificationHost from './notify/NotificationHost.vue'
import { HintPanel } from './components/common'

const router = useRouter()

// Boot splash (markup inherits the styles from index.html) stays visible until
// the FIRST navigation resolves — the router guard can hold start-up briefly
// while it restores a session. The wait is capped (SPLASH_BOUND_MS): with a
// stale/unreachable saved server the navigation must not keep the splash up
// forever ("infinite loading") — after the cap the app content shows as far as
// it got (login page, offline view, …).
const SPLASH_BOUND_MS = 6000
const ready = ref(false)
void Promise.race([
  router.isReady().then(() => true),
  new Promise((resolve) => setTimeout(resolve, SPLASH_BOUND_MS)),
]).then(() => {
  ready.value = true
})
</script>

<template>
  <div v-if="!ready" class="boot-splash">
    <div class="boot-logo">MVS ERP</div>
    <div class="boot-spinner" aria-hidden="true"></div>
  </div>
  <ReconnectToast />
  <SyncToast />
  <!-- Global error/success notifications (failed mutations, …) -->
  <NotificationHost />
  <!-- Global right-side hint panel: any "?" button opens its page here -->
  <HintPanel />
  <RouterView />
</template>

<style>
@import './styles/tokens.css';

/* The app shell owns the full viewport: no browser-level scrollbar can ever
   appear and shrink the app/header width — all scrolling happens inside the
   layout containers (see MainLayout .ml-main, timeline .tg-scroll). */
html,
body {
  height: 100%;
  overflow: hidden;
}

*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* Fixed planner cell width, responsive to the screen.
   Set on :root, grid tracks use var(--cell-width). */
:root {
  --cell-width: 32px;
}
@media (min-width: 1200px) {
  :root {
    --cell-width: 40px;
  }
}
@media (min-width: 1600px) {
  :root {
    --cell-width: 48px;
  }
}
@media (min-width: 1920px) {
  :root {
    --cell-width: 56px;
  }
}
</style>

