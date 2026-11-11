import { createApp, watch } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { setupHttp } from './http'
import { initTheme } from './theme'
import { applyUiSize, uiFontSize } from './settings'
import { useAuthStore } from './store'
import { initOfflineSync, startSessionMaintenance } from './offline/sync'
import { startConnectionMonitor } from './offline/connection'
import { ensureCacheVersion } from './offline/cache'
import { i18n } from './i18n'

setupHttp()
initTheme()
// UI font scale (small / default / large) — applied now and re-applied on change.
applyUiSize()
watch(uiFontSize, applyUiSize)

// Pinia is activated before touching the stores (auto re-login for the exe): otherwise
// useXStore() outside setup would fail with "no active Pinia".
const pinia = createPinia()
setActivePinia(pinia)

// The offline machinery (queue, cache, network monitor) and the background
// session support start here for every environment. The silent auto re-login itself is
// deliberately NOT awaited before mount: it is a real HTTP request to the
// configured backend, and with a saved session + a stale/unreachable server
// address (an old profile can keep one) it used to leave the window blank for
// the whole request duration ("white screen"). First paint must never wait on
// it — the router guard performs the re-login with its own short bound
// (DESKTOP_AUTOSYNC_BOUND_MS) and a late success navigates in via the watcher
// below. The boot itself is still capped (BOOT_BOUND_MS) as a safety net.
const BOOT_BOUND_MS = 4000

async function bootstrapApp(): Promise<void> {
  try {
    // Drop the GET cache when the app version changed (payload shape may differ
    // between releases); the mutation queue is never touched.
    await ensureCacheVersion()
    await initOfflineSync()
    // The connection monitor runs in EVERY environment (web + desktop): it keeps
    // isOffline/reconnectCountdown up to date via the /health probe and drives the
    // auto-PUSH/PULL loops while the connection is healthy. Idempotent.
    startConnectionMonitor()
    startSessionMaintenance()
  } catch (err) {
    // Never block the UI because of a broken offline/autosync init — surface it
    // in the log and render the login page anyway.
    console.error('[boot] offline init failed, continuing to render:', err)
  }
}

await Promise.race([
  bootstrapApp(),
  new Promise((resolve) => setTimeout(resolve, BOOT_BOUND_MS)),
])

// When a silent re-login (autosync / cookie refresh) finishes AFTER the router guard
// already gave up waiting and redirected to /login, move the user into the app
// automatically (to the requested redirect target, like the login submit does).
// Offline logins are excluded via sessionMode — they manage their own navigation.
{
  const auth = useAuthStore()
  watch(
    () => [auth.isAuthenticated, auth.sessionMode] as const,
    ([authenticated, sessionMode]) => {
      if (!authenticated || sessionMode !== 'online') return
      const current = router.currentRoute.value
      if (current.name !== 'login') return
      const redirect = typeof current.query.redirect === 'string' ? current.query.redirect : '/'
      void router.push(redirect)
    },
  )
}

console.log(`[build] ${__APP_VERSION__}`)

const app = createApp(App)

app.use(pinia)
app.use(router)
app.use(i18n)

app.mount('#app')
