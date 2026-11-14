/** Web access credentials are memory-only; Electron keeps all tokens in main. */
let accessToken: string | null = null

export function getAccessToken(): string {
  return accessToken ?? ''
}

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function accessTokenExpired(): boolean {
  const exp = accessTokenExpiresAt()
  return exp == null || exp <= Date.now()
}

export function accessTokenExpiresAt(token: string = getAccessToken()): number | null {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/')
    const data = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), '='))) as { exp?: number }
    return typeof data.exp === 'number' ? data.exp * 1000 : null
  } catch {
    return null
  }
}
