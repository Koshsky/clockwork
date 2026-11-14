import { stopApplicationPorts } from './store/data/applicationPorts'
import { createApp, watch } from 'vue'
import { createPinia, setActivePinia, disposePinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { setupHttp } from './http'
import { initTheme } from './theme'
import { applyUiSize, uiFontSize } from './settings'
import { useAuthStore } from './store'
import { createPlatformRuntime } from './platform/select'
import { createRuntimeHost, waitForPlatform } from './platform/current'
import { platformCapabilities } from './platform/context'
import { i18n } from './i18n'

setupHttp()
initTheme()
// UI font scale (small / default / large) — applied now and re-applied on change.
applyUiSize()
const stopUiSize = watch(uiFontSize, applyUiSize)

// Pinia is activated before touching the stores (auto re-login for the exe): otherwise
// useXStore() outside setup would fail with "no active Pinia".
const pinia = createPinia()
setActivePinia(pinia)

// Desktop replays saved edits before hydration, with the existing four-second
// safety bound. Web service startup never delays mounting the shared UI.
const runtimeHost = createRuntimeHost(createPlatformRuntime)
await waitForPlatform(runtimeHost.start(), platformCapabilities.bootstrapBoundMs)
let stopSessionRedirect: (() => void) | undefined

// When a silent re-login (autosync / cookie refresh) finishes AFTER the router guard
// already gave up waiting and redirected to /login, move the user into the app
// automatically (to the requested redirect target, like the login submit does).
// Offline logins are excluded via sessionMode — they manage their own navigation.
{
  const auth = useAuthStore()
  stopSessionRedirect = watch(
    () => [auth.isAuthenticated, auth.sessionMode] as const,
    ([authenticated, sessionMode]) => {
      const current = router.currentRoute.value
      if (platformCapabilities.kind === 'desktop' && !authenticated && current.meta.requiresAuth) {
        void router.replace({ name: 'login', query: { redirect: current.fullPath } })
        return
      }
      if (!authenticated || sessionMode !== 'online') return
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

const pauseRuntime = () => runtimeHost.stop()
const resumeRuntime = (event: PageTransitionEvent) => { if (event.persisted) runtimeHost.start() }
window.addEventListener('pagehide', pauseRuntime)
window.addEventListener('pageshow', resumeRuntime)
let disposed = false
function disposeApplication() {
  if (disposed) return
  disposed = true
  runtimeHost.stop()
  stopApplicationPorts()
  stopUiSize()
  stopSessionRedirect?.()
  disposePinia(pinia)
  window.removeEventListener('pagehide', pauseRuntime)
  window.removeEventListener('pageshow', resumeRuntime)
}
app.onUnmount(disposeApplication)
import.meta.hot?.dispose(disposeApplication)
