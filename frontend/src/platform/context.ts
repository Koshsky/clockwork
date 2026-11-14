import { detectCapabilities } from './capabilities'

export const platformCapabilities = detectCapabilities(typeof window === 'undefined' ? null : window.erpDesktop)
