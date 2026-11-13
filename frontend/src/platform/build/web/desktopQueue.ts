import type * as Native from '@/offline/desktopQueue'
export type { NativeCommand, DesktopQueue } from '@/offline/desktopQueue'

export const nativeQueue: typeof Native.nativeQueue = undefined
export const nativeSync = false
const unavailable = (): never => { throw new Error('WEB_OFFLINE_QUEUE_UNAVAILABLE') }
export const queueRequest: typeof Native.queueRequest = async () => unavailable()
export const nativeCommands: typeof Native.nativeCommands = async () => unavailable()
export const nativeEntry: typeof Native.nativeEntry = unavailable
export const enqueueNative: typeof Native.enqueueNative = async () => unavailable()
export const nativeDiscardPlan: typeof Native.nativeDiscardPlan = unavailable
export const queuedResponse: typeof Native.queuedResponse = () => false
export const desktopQueueMessage: typeof Native.desktopQueueMessage = unavailable
