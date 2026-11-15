// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { nextTick, type Ref } from 'vue'
import { branding, initBranding } from './branding'
import { desktopSessionState } from './session/desktop'
import { resolvedScheme } from './theme'
import { setAppLocale } from './i18n'

vi.mock('./theme', async () => ({ resolvedScheme: (await import('vue')).ref('light') }))
vi.mock('./session/desktop', async () => ({ desktopSessionState: (await import('vue')).ref(null) }))
let stop = () => {}
beforeEach(() => {
  desktopSessionState.value = null
  ;(resolvedScheme as Ref<string>).value = 'light'
  document.head.innerHTML = '<link rel="icon" href="/icons/icon.svg">'
  document.documentElement.style.cssText = ''
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { stop(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren() })
const flush = async () => { await vi.waitFor(() => expect(document.title).not.toBe('Clockwork')); await nextTick() }

it('applies server identity and reacts to theme changes', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: '<img src=x onerror=alert(1)>', primaryColor: '#7841AF' }))))
  stop = initBranding()
  await flush()
  expect(document.title).toBe('<img src=x onerror=alert(1)>')
  expect(document.querySelector('img')).toBeNull()
  const light = document.documentElement.style.getPropertyValue('--ui-accent')
  expect(light).not.toBe('')
  ;(resolvedScheme as Ref<string>).value = 'dark'; await nextTick()
  expect(document.documentElement.style.getPropertyValue('--ui-accent')).not.toBe(light)
})
it('starts the UI with defaults immediately while a configuration request is pending', () => {
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  stop = initBranding()
  expect(branding.value.name).toBe('Clockwork')
  expect(document.title).toBe('Clockwork')
})
it('ignores late branding from a previously selected server', async () => {
  let old!: (response: Response) => void
  const request = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { old = resolve })).mockResolvedValue(new Response(JSON.stringify({ name: 'New company' })))
  vi.stubGlobal('fetch', request)
  stop = initBranding()
  desktopSessionState.value = { server: 'https://new.example/api/v1' } as NonNullable<typeof desktopSessionState.value>
  await flush()
  expect(branding.value.name).toBe('New company')
  old(new Response(JSON.stringify({ name: 'Old company' }))); await new Promise(resolve => setTimeout(resolve, 10))
  expect(branding.value.name).toBe('New company')
})
it('restores default theme tokens after reconnecting to a server using Clockwork', async () => {
  vi.stubGlobal('fetch', vi.fn().mockImplementationOnce(async () => new Response(JSON.stringify({ name: 'Company', primaryColor: '#7841AF' }))).mockImplementation(async () => new Response('{}')))
  stop = initBranding(); await flush()
  expect(document.documentElement.style.getPropertyValue('--ui-accent')).not.toBe('')
  window.dispatchEvent(new Event('online'))
  await vi.waitFor(() => expect(branding.value.name).toBe('Clockwork'))
  await nextTick()
  expect(document.documentElement.style.getPropertyValue('--ui-accent')).toBe('')
})
it('keeps the current company identity and color during a failed same-server reconnect', async () => {
  const request = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Company', primaryColor: '#7841AF' }))).mockRejectedValue(new TypeError('private URL unavailable'))
  vi.stubGlobal('fetch', request)
  stop = initBranding(); await flush()
  const color = document.documentElement.style.getPropertyValue('--ui-accent')
  window.dispatchEvent(new Event('online'))
  expect(branding.value.name).toBe('Company')
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2))
  await nextTick()
  expect(document.title).toBe('Company')
  expect(document.documentElement.style.getPropertyValue('--ui-accent')).toBe(color)
})
it('clears the previous company immediately when switching to an unavailable server', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ name: 'Company' }))).mockRejectedValue(new Error('offline')))
  stop = initBranding(); await flush()
  desktopSessionState.value = { server: 'https://other.example/api/v1' } as NonNullable<typeof desktopSessionState.value>
  await nextTick()
  expect(branding.value.name).toBe('Clockwork')
})
it('keeps the deployment title while changing the real application locale', async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ name: 'Company' })))
  vi.stubGlobal('fetch', request)
  stop = initBranding(); await flush()
  for (const locale of ['en', 'ru'] as const) {
    setAppLocale(locale); await nextTick()
    expect(document.documentElement.lang).toBe(locale)
    expect(document.title).toBe('Company')
  }
  expect(request).toHaveBeenCalledOnce()
})
it('rejects compressed logos with excessive dimensions without invoking the browser decoder', async () => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='), char => char.charCodeAt(0))
  new DataView(bytes.buffer).setUint32(16, 100000)
  const image = vi.fn()
  vi.stubGlobal('Image', image)
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'Company', logo: 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes)) }))))
  stop = initBranding(); await flush()
  expect(branding.value.logo).toBeNull()
  expect(image).not.toHaveBeenCalled()
})
