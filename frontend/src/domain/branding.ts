export interface Branding {
  name: string
  primaryColor: string
  logo: string | null
}

export const DEFAULT_BRANDING: Readonly<Branding> = Object.freeze({ name: 'Clockwork', primaryColor: '#1A73E8', logo: null })
export const BRANDING_PATH = '/assets/custom/branding/config.json'
export const LOGO_LIMIT = 256 * 1024
export const CONFIG_LIMIT = 512 * 1024
export const LOGO_MAX_DIMENSION = 2048
export const LOGO_MAX_PIXELS = 1024 * 1024

function safeSize(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= LOGO_MAX_DIMENSION && height <= LOGO_MAX_DIMENSION && width * height <= LOGO_MAX_PIXELS
}

function pngSize(bytes: Uint8Array, view: DataView): boolean {
  if (bytes.length < 33 || view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452 || !safeSize(view.getUint32(16), view.getUint32(20))) return false
  let image = false
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = view.getUint32(offset), type = view.getUint32(offset + 4)
    if (length > bytes.length - offset - 12 || type === 0x6163544c || (type === 0x49484452 && offset !== 8)) return false
    if (type === 0x49444154) image = true
    offset += length + 12
    if (type === 0x49454e44) return image && length === 0 && offset === bytes.length
  }
  return false
}

function jpegSize(bytes: Uint8Array, view: DataView): boolean {
  let frame = false, entropy = false
  for (let offset = 2; offset < bytes.length;) {
    if (entropy) { while (offset < bytes.length && bytes[offset] !== 255) offset++ }
    if (bytes[offset++] !== 255) return false
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 0 || (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)) {
      if (!entropy) return false
      continue
    }
    if (marker === 0xd9) return frame && offset === bytes.length
    if (marker === undefined || marker === 0xd8 || offset + 2 > bytes.length) return false
    const length = view.getUint16(offset)
    if (length < 2 || length > bytes.length - offset) return false
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (frame || ![0xc0, 0xc1, 0xc2].includes(marker) || length < 8 || !safeSize(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false
      if (bytes[offset + 2] !== 8 || ![1, 3, 4].includes(bytes[offset + 7]!) || length !== 8 + bytes[offset + 7]! * 3) return false
      frame = true
    }
    entropy = marker === 0xda
    offset += length
  }
  return false
}

function webpSize(bytes: Uint8Array, view: DataView): boolean {
  if (view.getUint32(4, true) !== bytes.length - 8) return false
  let image = false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const type = view.getUint32(offset), length = view.getUint32(offset + 4, true), start = offset + 8
    if (length > bytes.length - start || [0x414e494d, 0x414e4d46].includes(type)) return false
    if (type === 0x56503858) {
      if (offset !== 12 || length !== 10 || (bytes[start]! & 2)) return false
      const width = 1 + bytes[start + 4]! + bytes[start + 5]! * 256 + bytes[start + 6]! * 65536
      const height = 1 + bytes[start + 7]! + bytes[start + 8]! * 256 + bytes[start + 9]! * 65536
      if (!safeSize(width, height)) return false
    }
    if (type === 0x56503820 || type === 0x5650384c) {
      if (image) return false
      image = true
      if (type === 0x56503820) {
        if (length < 10 || (bytes[start]! & 1) || bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a || !safeSize(view.getUint16(start + 6, true) & 0x3fff, view.getUint16(start + 8, true) & 0x3fff)) return false
      } else {
        if (length < 5 || bytes[start] !== 0x2f) return false
        const header = view.getUint32(start + 1, true)
        if ((header >>> 29) || !safeSize((header & 0x3fff) + 1, ((header >>> 14) & 0x3fff) + 1)) return false
      }
    }
    offset = start + length + (length % 2)
    if (offset === bytes.length) return image
  }
  return false
}

function imageType(bytes: Uint8Array): string | null {
  if (bytes.length > LOGO_LIMIT) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // Inspect dimensions and reject animation before handing bytes to a decoder.
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) && pngSize(bytes, view)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && jpegSize(bytes, view)) return 'image/jpeg'
  if (bytes.length >= 12 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250 && webpSize(bytes, view)) return 'image/webp'
  return null
}

export function createBrandingReporter(report: (code: string) => void = code => console.warn(`[branding] ${code}`), now = Date.now): (code: string) => void {
  let last = -Infinity
  return code => {
    if (now() - last < 60000) return
    last = now()
    report(code)
  }
}

export class BrandingHttpError extends Error {
  constructor(readonly status: number) { super('BRANDING_UNAVAILABLE') }
}

function imageData(bytes: Uint8Array): string | null {
  const type = imageType(bytes)
  if (!type) return null
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:${type};base64,${btoa(binary)}`
}

function safeDataImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > CONFIG_LIMIT) return null
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match) return null
  try {
    const bytes = Uint8Array.from(atob(match[2]!), char => char.charCodeAt(0))
    return imageType(bytes) === match[1] ? imageData(bytes) : null
  } catch { return null }
}

export function normalizeBranding(value: unknown): Branding {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  return {
    name: name && [...name].length <= 80 && !/[\u0000-\u001f\u007f]/.test(name) ? name : DEFAULT_BRANDING.name,
    primaryColor: typeof record.primaryColor === 'string' && /^#[0-9a-f]{6}$/i.test(record.primaryColor) ? record.primaryColor.toUpperCase() : DEFAULT_BRANDING.primaryColor,
    logo: safeDataImage(record.logo),
  }
}

export async function loadBranding(read: (path: string, limit: number) => Promise<Uint8Array>, report: (code: string) => void = () => {}): Promise<Branding> {
  let raw: unknown
  try {
    const bytes = await read(BRANDING_PATH, CONFIG_LIMIT)
    raw = JSON.parse(new TextDecoder().decode(bytes))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['name', 'primaryColor', 'logo'].includes(key))) throw new Error('BRANDING_INVALID_CONFIG')
  } catch (error) {
    if (error instanceof BrandingHttpError && error.status === 404) return { ...DEFAULT_BRANDING }
    report('config-unavailable-or-invalid')
    throw error
  }
  const result = normalizeBranding(raw)
  const record = raw as Record<string, unknown>, logo = record.logo
  if ((record.name !== undefined && result.name !== (typeof record.name === 'string' ? record.name.trim() : record.name)) || (record.primaryColor !== undefined && result.primaryColor !== (typeof record.primaryColor === 'string' ? record.primaryColor.toUpperCase() : record.primaryColor))) report('invalid-branding-field')
  // Only sibling raster files can become images; URLs, paths and SVG stay inert.
  if (typeof logo === 'string' && /^[a-z0-9][a-z0-9_.-]{0,100}\.(png|jpe?g|webp)$/i.test(logo)) {
    try { result.logo = imageData(await read(BRANDING_PATH.replace('config.json', logo), LOGO_LIMIT)) }
    catch (error) {
      if (!(error instanceof BrandingHttpError && error.status === 404)) { report('logo-unavailable'); throw error }
    }
  }
  if (logo != null && !result.logo) report('invalid-or-missing-logo')
  return result
}

export async function readBrandingResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get('Content-Length')) > limit || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new BrandingHttpError(response.status)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error('BRANDING_RESPONSE_LIMIT')
      chunks.push(value)
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

function rgb(color: string): number[] {
  return [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16))
}

export function contrast(first: string, second: string): number {
  const luminance = (color: string) => rgb(color).map(value => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0)
  const a = luminance(first), b = luminance(second)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export function brandPalette(color: string, dark: boolean): Record<string, string> {
  const surface = dark ? '#111827' : '#FFFFFF'
  const target = dark ? 255 : 0
  const channels = rgb(color)
  let accent = color
  // The accent is also used for labels, so it needs contrast against the surface.
  for (let step = 0; contrast(accent, surface) < 4.5 && step <= 100; step++) {
    accent = '#' + channels.map(value => Math.round(value + (target - value) * step / 100).toString(16).padStart(2, '0')).join('')
  }
  return {
    '--ui-accent': accent,
    '--ui-focus': accent,
    '--ui-accent-soft': `color-mix(in srgb, ${accent} ${dark ? 18 : 10}%, ${surface})`,
    '--ui-accent-on': contrast(accent, '#FFFFFF') >= contrast(accent, '#000000') ? '#FFFFFF' : '#000000',
  }
}
