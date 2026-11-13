import { ref } from 'vue'
import type * as Native from '@/session/desktop'
export type { SessionState, DesktopSession } from '@/session/desktop'

export const desktopSession: typeof Native.desktopSession = undefined
export const desktopSessionState = ref<Native.SessionState | null>(null)
const unavailable = async (): Promise<never> => { throw new Error('WEB_DESKTOP_SESSION_UNAVAILABLE') }
export const prepareDesktopSession: typeof Native.prepareDesktopSession = unavailable
export const desktopAction: typeof Native.desktopAction = unavailable
export const desktopSessionAdapter: typeof Native.desktopSessionAdapter = unavailable
