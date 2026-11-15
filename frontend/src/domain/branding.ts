export interface Branding {
  name: string
  primaryColor: string
  logo: string | null
}

export const DEFAULT_BRANDING: Readonly<Branding> = Object.freeze({ name: 'Clockwork', primaryColor: '#1A73E8', logo: null })
export const BRANDING_PATH = '/assets/custom/branding/config.json'
export const LOGO_LIMIT = 256 * 1024
export const CONFIG_LIMIT = 512 * 1024

function imageType(bytes: Uint8Array): string | null {
  if (bytes.length > LOGO_LIMIT) return null
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP') return 'image/webp'
  return null
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

export async function loadBranding(read: (path: string, limit: number) => Promise<Uint8Array>): Promise<Branding> {
  const bytes = await read(BRANDING_PATH, CONFIG_LIMIT)
  const raw: unknown = JSON.parse(new TextDecoder().decode(bytes))
  const result = normalizeBranding(raw)
  const logo = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).logo : null
  // Only sibling raster files can become images; URLs, paths and SVG stay inert.
  if (typeof logo === 'string' && /^[a-z0-9][a-z0-9_.-]{0,100}\.(png|jpe?g|webp)$/i.test(logo)) {
    try { result.logo = imageData(await read(BRANDING_PATH.replace('config.json', logo), LOGO_LIMIT)) }
    catch { result.logo = null }
  }
  return result
}

export async function readBrandingResponse(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get('Content-Length')) > limit || !response.body) {
    await response.body?.cancel().catch(() => {})
    throw new Error('BRANDING_UNAVAILABLE')
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
