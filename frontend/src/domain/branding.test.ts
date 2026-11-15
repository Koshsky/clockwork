import { describe, expect, it } from 'vitest'
import { BRANDING_PATH, CONFIG_LIMIT, DEFAULT_BRANDING, LOGO_LIMIT, LOGO_MAX_PIXELS, BrandingHttpError, brandPalette, contrast, loadBranding, normalizeBranding, readBrandingResponse } from './branding'

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
      if (kind === 'missing') throw new BrandingHttpError(404)
      if (kind === 'oversized') return new Uint8Array(LOGO_LIMIT + 1)
      return new TextEncoder().encode('<script>alert(1)</script>')
    })
    expect(result).toEqual({ name: 'Company', primaryColor: '#008800', logo: null })
  })
  it('does not mistake the SPA HTML fallback for valid configuration', async () => {
    await expect(loadBranding(async () => new TextEncoder().encode('<html>App</html>'))).rejects.toThrow()
  })
  it.each([null, [], 1, 'Clockwork', true])('rejects non-object config %j instead of replacing a cached brand with defaults', async value => {
    await expect(loadBranding(async () => encode(value))).rejects.toThrow('BRANDING_INVALID_CONFIG')
  })
  it('propagates transient logo failures so a partial identity cannot overwrite the cache', async () => {
    await expect(loadBranding(async path => {
      if (path === BRANDING_PATH) return encode({ name: 'Company', logo: 'logo.png' })
      throw new TypeError('Network unavailable')
    })).rejects.toThrow('Network unavailable')
  })
  it.each([[0, 10], [10, 0], [2049, 1], [1, 2049], [1025, 1024]])('rejects PNG dimensions %j x %j before decoding', (width, height) => {
    const bytes = png.slice(), view = new DataView(bytes.buffer)
    view.setUint32(16, width!); view.setUint32(20, height!)
    expect(normalizeBranding({ logo: 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes)) }).logo).toBeNull()
  })
  it('accepts the pixel limit but rejects animated PNG containers', () => {
    const bytes = png.slice(), view = new DataView(bytes.buffer)
    view.setUint32(16, 1024); view.setUint32(20, LOGO_MAX_PIXELS / 1024)
    expect(normalizeBranding({ logo: 'data:image/png;base64,' + btoa(String.fromCharCode(...bytes)) }).logo).not.toBeNull()
    const animated = new Uint8Array(png.length + 12)
    animated.set(png.slice(0, 33)); animated.set([0, 0, 0, 0, 97, 99, 84, 76], 33); animated.set(png.slice(33), 45)
    expect(normalizeBranding({ logo: 'data:image/png;base64,' + btoa(String.fromCharCode(...animated)) }).logo).toBeNull()
  })
  it.each(['jpeg', 'webp-lossy', 'webp-lossless', 'webp-extended'])('bounds %s dimensions before decoding', kind => {
    const image = (width: number, height: number) => {
      if (kind === 'jpeg') return Uint8Array.from([255, 216, 255, 192, 0, 11, 8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0, 255, 217])
      const frame = kind === 'webp-lossy' ? Uint8Array.from([0, 0, 0, 0x9d, 1, 0x2a, width & 255, width >> 8, height & 255, height >> 8]) : new Uint8Array(6)
      if (kind !== 'webp-lossy') { frame[0] = 0x2f; new DataView(frame.buffer).setUint32(1, (width - 1) | ((height - 1) << 14), true) }
      const header = kind === 'webp-extended' ? new Uint8Array(18) : new Uint8Array()
      if (header.length) {
        header.set(new TextEncoder().encode('VP8X')); header[4] = 10
        header[12] = (width - 1) & 255; header[13] = (width - 1) >> 8
        header[15] = (height - 1) & 255; header[16] = (height - 1) >> 8
      }
      const bytes = new Uint8Array(12 + header.length + 8 + frame.length)
      bytes.set(new TextEncoder().encode('RIFF')); bytes.set(new TextEncoder().encode('WEBP'), 8)
      new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true)
      bytes.set(header, 12); bytes.set(new TextEncoder().encode(kind === 'webp-lossy' ? 'VP8 ' : 'VP8L'), 12 + header.length)
      new DataView(bytes.buffer).setUint32(16 + header.length, frame.length, true)
      bytes.set(frame, 20 + header.length)
      return bytes
    }
    for (const [width, height] of [[10, 10], [2049, 1], [1025, 1024]]) {
      const bytes = image(width!, height!), type = kind === 'jpeg' ? 'jpeg' : 'webp'
      expect(normalizeBranding({ logo: `data:image/${type};base64,` + btoa(String.fromCharCode(...bytes)) }).logo !== null).toBe(width === 10)
    }
    if (kind === 'webp-extended') {
      const animated = image(10, 10); animated[20] = 2
      expect(normalizeBranding({ logo: 'data:image/webp;base64,' + btoa(String.fromCharCode(...animated)) }).logo).toBeNull()
      const mismatch = image(2049, 1); mismatch.set([9, 0, 0], 24)
      expect(normalizeBranding({ logo: 'data:image/webp;base64,' + btoa(String.fromCharCode(...mismatch)) }).logo).toBeNull()
    }
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
