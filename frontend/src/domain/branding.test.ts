import { describe, expect, it } from 'vitest'
import { BRANDING_PATH, CONFIG_LIMIT, DEFAULT_BRANDING, LOGO_LIMIT, brandPalette, contrast, loadBranding, normalizeBranding, readBrandingResponse } from './branding'

const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII='), char => char.charCodeAt(0))
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))

describe('server branding', () => {
  it.each([null, [], 7, {}, { name: '  ', primaryColor: 'blue' }, { name: 'x'.repeat(81), primaryColor: 'red;display:none' }, { name: 'line\nbreak' }])('falls back to Clockwork for invalid configuration %j', value => {
    expect(normalizeBranding(value)).toEqual(DEFAULT_BRANDING)
  })
  it('keeps company text as data and filters fields instead of accepting CSS/HTML', () => {
    expect(normalizeBranding({ name: '  Company <b>name</b>  ', primaryColor: '#aBcDeF', style: 'display:none' })).toEqual({ name: 'Company <b>name</b>', primaryColor: '#ABCDEF', logo: null })
  })
  it('loads a sibling raster logo and embeds it for offline display and PDF', async () => {
    const paths: string[] = []
    const result = await loadBranding(async (path, limit) => {
      paths.push(path)
      if (path === BRANDING_PATH) { expect(limit).toBe(CONFIG_LIMIT); return encode({ name: 'Company', primaryColor: '#7841AF', logo: 'logo.png' }) }
      expect(limit).toBe(LOGO_LIMIT)
      return png
    })
    expect(paths).toEqual([BRANDING_PATH, '/assets/custom/branding/logo.png'])
    expect(result).toEqual({ name: 'Company', primaryColor: '#7841AF', logo: 'data:image/png;base64,' + btoa(String.fromCharCode(...png)) })
    expect(normalizeBranding(result)).toEqual(result)
  })
  it.each(['../logo.png', 'https://evil.example/logo.png', '//evil/logo.png', 'file:///tmp/logo.png', 'logo.svg', 'logo.png?x=1', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/png;base64,PHN2Zz4='])('does not fetch or expose unsafe logo %s', async logo => {
    let reads = 0
    const result = await loadBranding(async () => { reads++; return encode({ name: 'Company', logo }) })
    expect(reads).toBe(1)
    expect(result.logo).toBeNull()
    expect(result.name).toBe('Company')
  })
  it.each(['missing', 'html', 'oversized'])('keeps valid text and color if logo is %s', async kind => {
    const result = await loadBranding(async path => {
      if (path === BRANDING_PATH) return encode({ name: 'Company', primaryColor: '#008800', logo: 'logo.png' })
      if (kind === 'missing') throw new Error('404')
      if (kind === 'oversized') return new Uint8Array(LOGO_LIMIT + 1)
      return new TextEncoder().encode('<script>alert(1)</script>')
    })
    expect(result).toEqual({ name: 'Company', primaryColor: '#008800', logo: null })
  })
  it('does not mistake the SPA HTML fallback for valid configuration', async () => {
    await expect(loadBranding(async () => new TextEncoder().encode('<html>App</html>'))).rejects.toThrow()
  })
  it('cancels a chunked oversized response without trusting its declared length', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20)); controller.enqueue(new Uint8Array(20)) }, cancel() { cancelled = true } })
    await expect(readBrandingResponse(new Response(body, { headers: { 'Content-Length': '1' } }), 30)).rejects.toThrow('BRANDING_RESPONSE_LIMIT')
    expect(cancelled).toBe(true)
  })
  it.each([404, 500])('rejects HTTP %s rather than caching its error document', async status => {
    await expect(readBrandingResponse(new Response('{}', { status }), 100)).rejects.toThrow('BRANDING_UNAVAILABLE')
  })
  it.each(['#000000', '#FFFFFF', '#FFFF00', '#7841AF', '#FF0000', '#008800'])('preserves readable controls for %s in both schemes', color => {
    for (const dark of [false, true]) {
      const palette = brandPalette(color, dark)
      expect(contrast(palette['--ui-accent']!, dark ? '#111827' : '#FFFFFF')).toBeGreaterThanOrEqual(4.5)
      expect(contrast(palette['--ui-accent']!, palette['--ui-accent-on']!)).toBeGreaterThanOrEqual(4.5)
    }
  })
})
