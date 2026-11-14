export { lastPullAt } from '@/offline/freshness'
export const retryConnectionNow = async (): Promise<never> => { throw new Error('WEB_LEGACY_MONITOR_UNAVAILABLE') }
export const startConnectionMonitor = (): never => { throw new Error('WEB_LEGACY_MONITOR_UNAVAILABLE') }
export function stopConnectionMonitor(): void {}
