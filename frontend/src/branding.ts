import { readonly, ref, watch } from 'vue'
import { DEFAULT_BRANDING, brandPalette, createBrandingReporter, loadBranding, readBrandingResponse } from './domain/branding'
import { resolvedScheme } from './theme'
import { desktopSessionState } from './session/desktop'

const current = ref({ ...DEFAULT_BRANDING })
export const branding = readonly(current)

export function initBranding(): () => void {
  let epoch = 0
  let request: AbortController | undefined
  const report = createBrandingReporter()
  current.value = { ...DEFAULT_BRANDING }
  const apply = () => {
    const root = document.documentElement
    document.title = current.value.name
    for (const name of ['--ui-accent', '--ui-accent-soft', '--ui-accent-on', '--ui-focus']) root.style.removeProperty(name)
    if (current.value.primaryColor !== DEFAULT_BRANDING.primaryColor) {
      for (const [name, value] of Object.entries(brandPalette(current.value.primaryColor, resolvedScheme.value === 'dark'))) root.style.setProperty(name, value)
    }
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
    if (icon) icon.href = current.value.logo ?? '/icons/icon.svg'
  }
  const reload = async (reset = false) => {
    const own = ++epoch
    request?.abort()
    if (reset) current.value = { ...DEFAULT_BRANDING }
    const controller = new AbortController()
    request = controller
    const timeout = setTimeout(() => controller.abort(), 4000)
    try {
      const next = await loadBranding(async (path, limit) => readBrandingResponse(await fetch(path, {
        signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error',
      }), limit), code => { if (own === epoch) report(code) })
      if (next.logo) {
        const image = new Image()
        image.src = next.logo
        try { await image.decode() }
        catch { next.logo = null; report('logo-decode-failed') }
      }
      if (own === epoch) current.value = next
    } catch { /* Failed refreshes preserve the last identity for the current server. */ }
    finally { clearTimeout(timeout) }
  }
  const stopApply = watch([current, resolvedScheme], apply, { immediate: true, flush: 'sync' })
  const stopServer = watch([
    () => desktopSessionState.value?.server,
    () => desktopSessionState.value?.mode === 'online',
  ], ([server], previous) => { void reload(server !== previous?.[0]) }, { immediate: true })
  const online = () => { void reload() }
  window.addEventListener('online', online)
  return () => { epoch++; request?.abort(); stopApply(); stopServer(); window.removeEventListener('online', online) }
}
