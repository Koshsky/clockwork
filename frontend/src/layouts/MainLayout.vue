<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppHeader from '../components/common/AppHeader/AppHeader.vue'
import AppNavDrawer from '../components/common/AppNavDrawer/AppNavDrawer.vue'
import { useRbacStore } from '../store'
import { pageAllowed } from '@/utils/pageAccess'
import { uncertainCommands, retryUncertainCommand, dismissUncertainCommand } from '@/store/data/webCommands'
import { useNavigation } from '../composables/useNavigation'
import { saveCategoryOrder, saveItemOrder } from '../composables/useNavigationOrder'
import {
  installDrawerEdgeDetection,
  closeNav,
  isNavOpen,
  isNarrowScreen,
} from '../composables/useNavDrawer'

const route = useRoute()
const rbac = useRbacStore()
const router = useRouter()

watch(() => rbac.permsLoaded && !pageAllowed(String(route.name), rbac.can), (denied) => {
  if (denied) void router.replace({ name: 'profile' })
}, { immediate: true })
const { visibleCategories } = useNavigation()

/**
 * Close request from the drawer (scrim tap, item click). On desktop the drawer
 * is a pinned layout column and stays open — only the narrow-screen overlay
 * mode closes (the scrim is the only close path without a navigation).
 */
function onDrawerCloseRequest(): void {
  if (isNarrowScreen()) closeNav()
}

/**
 * Narrow screens: after ANY navigation (menu item, programmatic navigation,
 * Android hardware back / browser back) the overlay drawer must not stay
 * open. Desktop (pinned layout column) is intentionally unaffected.
 */
watch(route, () => {
  if (isNarrowScreen() && isNavOpen.value) closeNav()
})

/** Applies a section drag onto the navigation order. */
function onReorderCategory(p: { from: number; to: number }) {
  const labels = visibleCategories.value.map((c) => c.label)
  saveCategoryOrder(labels, p.from, p.to)
}

/** Applies a subsection drag (only within its parent section). */
function onReorderItem(p: { catLabel: string; from: number; to: number }) {
  const cat = visibleCategories.value.find((c) => c.label === p.catLabel)
  const names = cat ? cat.items.map((i) => i.name) : []
  if (names.length) saveItemOrder(p.catLabel, names, p.from, p.to)
}

// Route name as a plain string (route.name can also be a symbol in edge cases)
const routeName = computed(() => (typeof route.name === 'string' ? route.name : undefined))

let stopPermissionSync: (() => void) | undefined
let stopDrawerDetection: (() => void) | undefined

/**
 * Global Ctrl/Cmd+P and Ctrl/Cmd+S interception: the browser's "Print page"
 * and "Save page" are suppressed across the whole app (they cover modals),
 * while opening the print-preparation modal is done by the
 * app:print-request event listener (PdfExport on the "Tasks" page).
 * Matching goes by e.code (physical key, independent of the layout —
 * on the Russian ЙЦУКЕН layout e.key for P/S yields «з»/«ы»), e.key as a fallback.
 * We listen on window in the capture phase: the earliest interception before the browser.
 */
function onPrintHotkey(e: KeyboardEvent) {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) {
    const code = e.code
    const key = e.key.toLowerCase()
    if (code === 'KeyP' || code === 'KeyS' || key === 'p' || key === 's') {
      e.preventDefault()
      window.dispatchEvent(new CustomEvent('app:print-request'))
    }
  }
}

onMounted(() => {
  window.addEventListener('keydown', onPrintHotkey, true)
  stopPermissionSync = rbac.startPermissionSync()
  stopDrawerDetection = installDrawerEdgeDetection()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onPrintHotkey, true)
  stopPermissionSync?.()
  stopDrawerDetection?.()
})
</script>

<template>
  <div class="ml">
    <!-- Navigation drawer as a real layout column: when open it takes
         NAV_WIDTH and the content column smoothly shifts to the right -->
    <AppNavDrawer
      :open="isNavOpen"
      :categories="visibleCategories"
      :active-name="routeName"
      @close="onDrawerCloseRequest"
      @reorder-category="onReorderCategory"
      @reorder-item="onReorderItem"
    />
    <div class="ml-col">
      <AppHeader />
      <div class="ml-body">
        <main class="ml-main">
          <p v-if="rbac.permissionsError" role="alert" class="ml-read-error">{{ rbac.permissionsError }}</p>
          <section v-if="uncertainCommands.length" class="ml-command-status" role="status">
            <p>{{ $t('common.commandUncertainCount', { count: uncertainCommands.length }) }}</p>
            <div v-for="command in uncertainCommands" :key="command.id" class="ml-command-actions">
              <span>{{ $t(command.sensitive ? 'common.commandSecretUnknown' : command.retryable ? 'common.commandUnknown' : 'common.commandCheckResult') }}</span>
              <button v-if="command.retryable" type="button" class="btn" :disabled="command.busy" @click="retryUncertainCommand(command.id)">{{ $t('common.commandRetry') }}</button>
              <button type="button" class="btn" :disabled="command.busy" @click="dismissUncertainCommand(command.id)">{{ $t(command.sensitive || !command.retryable ? 'common.commandChecked' : 'common.commandDismiss') }}</button>
            </div>
          </section>
          <RouterView />
        </main>
      </div>
    </div>
  </div>
</template>

<style scoped>
@import '../styles/tokens.css';

.ml-read-error { color: var(--ui-danger); margin-bottom: 12px; }
.ml-command-status { padding: 12px; margin-bottom: 12px; border: 1px solid var(--ui-border); border-radius: 8px; }
.ml-command-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.ml {
  height: 100vh;
  height: 100dvh; /* exact device viewport; the page can never exceed it */
  overflow: hidden; /* no page scroll / page scrollbar — content scrolls inside */
  display: flex;
  flex-direction: row;
  background: var(--ui-bg);
}

/* Content column: header + scrollable main area */
.ml-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.ml-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  margin: 0;
}

.ml-main {
  flex: 1;
  min-height: 0;
  padding: 24px;
  overflow: auto; /* non-diagram pages scroll inside the frame, not the browser */
  /* reserved gutter: pages with and without a scrollbar have the same content
     width — nothing shifts when switching between lists and diagrams */
  scrollbar-gutter: stable;
}
</style>
