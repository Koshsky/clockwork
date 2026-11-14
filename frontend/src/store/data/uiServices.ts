import { desktopDataState } from '@/data/desktopState'
import { nativeBusinessPorts } from './applicationPorts'
import { computed, watch } from 'vue'
import type { ApplicationData, CommandResult, DataFailure, ReadOperations, SessionState } from '@/data/contracts'
import { useAppStore, useAuthStore, usePlanningStore, useRbacStore } from '@/store'
import { getApiUrl, setApiUrl } from '@/config'
import { platformCapabilities } from '@/platform/context'
import { desktopSession, prepareDesktopSession } from '@/session/desktop'
import { businessBindings } from '@/data/businessRequest'
import { applicationPorts } from './applicationPorts'
import { isOffline, probeBackend, reconnectDeadline } from '@/offline/state'
import { pendingCount, pushProgress, pendingRefs, queueItems, refreshPendingCount, getFailedEntries } from '@/offline/outbox'
import { lastPullAt as legacyLastPullAt } from '@/offline/connection'
import { warmNow, warmupProgress } from '@/offline/warmup'
import { syncNow, syncAll, syncNotice, dismissSyncNotice, retryFailed, discardFailed, lastPushAt, scheduleNamedRefresh } from '@/offline/sync'
import { nativeQueue, nativeCommands, nativeDiscardPlan, queueRequest } from '@/offline/desktopQueue'
import { legacyQueueAvailability } from '@/platform/state'
import { t } from '@/i18n'

export const lastPullAt = computed(() => nativeBusinessPorts() ? desktopDataState.value?.sync?.lastPullAt ?? null : legacyLastPullAt.value)

export type { MutationEntity } from '@/offline/outbox'
export { retryPlatformConnection } from '@/platform/current'
export { reconnectDeadline, scheduleNamedRefresh, isOffline, probeBackend, pendingCount, pushProgress, pendingRefs, queueItems, refreshPendingCount, getFailedEntries, lastPushAt, warmupProgress, syncNotice, dismissSyncNotice, retryFailed, discardFailed }
const unavailable = (): DataFailure => ({ kind: 'unavailable', message: t('common.networkError') })
const sessionState = (): SessionState => {
  const auth = useAuthStore()
  return { user: auth.user, mode: !auth.isAuthenticated ? 'anonymous' : auth.sessionMode }
}
const sessionResult = (ok: boolean) => ok
  ? { status: 'ok' as const, data: sessionState(), source: isOffline.value ? 'snapshot' as const : 'refresh' as const }
  : { status: 'failed' as const, error: { ...unavailable(), message: useAuthStore().error || t('common.networkError') } }

export const applicationData: ApplicationData = {
  scope: () => { const server = getApiUrl(), accountId = useAuthStore().user?.id; return server && accountId ? { server, accountId } : null },
  reads: { read: async (operation, input, options) => (await applicationPorts()).reads.read(operation, input, options) },
  commands: { execute: async (operation, input, options) => (await applicationPorts()).commands.execute(operation, input, options) },
  capabilities: {
    offlineReads: platformCapabilities.offlineBootstrap,
    offlineCommands: platformCapabilities.offlineBootstrap ? businessBindings.filter(binding => binding.kind === 'command' && !/^(account|comment|rbac|template)\./.test(binding.operation)).map(binding => binding.operation) as ApplicationData['capabilities']['offlineCommands'] : [],
    serverSelection: platformCapabilities.serverSelection,
    queueControls: platformCapabilities.offlineBootstrap,
  },
  session: {
    current: sessionState,
    subscribe(listener) { const auth = useAuthStore(); listener(sessionState()); return watch(() => [auth.user, auth.isAuthenticated, auth.sessionMode], () => listener(sessionState()), { deep: true }) },
    async login(username, password) { return sessionResult(await useAuthStore().login(username, password)) },
    async enterOffline(username) { return !platformCapabilities.offlineBootstrap ? { status: 'failed', error: unavailable() } : sessionResult(await useAuthStore().enterOffline(username ?? useAuthStore().user?.username ?? null)) },
    async refresh() { return sessionResult(await useAuthStore().refreshSession()) },
    async logout() { await useAuthStore().logout() },
    async changePassword(oldPassword, newPassword) { return await useAuthStore().changePassword(oldPassword, newPassword) ? { status: 'confirmed', data: null } : { status: 'rejected', error: { ...unavailable(), message: useAuthStore().error || t('common.networkError') } } },
    async resetPassword(userId): Promise<CommandResult<{ password: string }>> {
      const password = await useAppStore().resetPassword(userId)
      return password != null ? { status: 'confirmed', data: { password } } : { status: 'rejected', error: { ...unavailable(), message: useAppStore().adminUsersError || t('common.networkError') } }
    },
  },
  sync: {
    current: () => ({ connection: isOffline.value ? 'offline' : 'online', phase: desktopDataState.value?.queue?.running || pushProgress.value != null ? 'pushing' : desktopDataState.value?.sync?.running || warmupProgress.value != null ? 'pulling' : 'idle', pending: platformCapabilities.offlineBootstrap ? pendingCount.value : 0, rejected: syncNotice.value?.failed ?? 0, nextRefreshAt: lastPullAt.value != null ? lastPullAt.value + 60000 : null }),
    subscribe(listener) { listener(this.current()); return watch([isOffline, pendingCount, warmupProgress, pushProgress, lastPullAt, syncNotice, desktopDataState], () => listener(this.current())) },
    async pull() { return await warmNow(true) ? { status: 'ok', data: null, source: 'refresh' } : { status: 'failed', error: unavailable() } },
    async push() { if (!platformCapabilities.offlineBootstrap) return { status: 'failed', error: unavailable() }; await syncNow(); return syncNotice.value?.interrupted || syncNotice.value?.failed ? { status: 'failed', error: unavailable() } : { status: 'ok', data: null, source: 'refresh' } },
    async retry(operationId) { if (!platformCapabilities.offlineBootstrap) throw new Error('APPLICATION_QUEUE_UNAVAILABLE'); if (nativeQueue) await queueRequest({ action: 'retry', operationId }); else await retryFailed() },
    async discard(operationIds) { if (!platformCapabilities.offlineBootstrap) throw new Error('APPLICATION_QUEUE_UNAVAILABLE'); if (nativeQueue) await queueRequest({ action: 'discard', operationIds }); else if (platformCapabilities.offlineBootstrap) await discardFailed() },
    async selectServer(server) { if (!platformCapabilities.serverSelection || !setApiUrl(server, true)) throw new Error('APPLICATION_SERVER_UNAVAILABLE'); if (desktopSession) await prepareDesktopSession() },
  },
  changes: {
    subscribe(listener) {
      const app = useAppStore(), planning = usePlanningStore(), rbac = useRbacStore()
      return watch(() => [app.resources, app.projects, app.users, planning.projectPlanning, planning.processPlanning, planning.taskPlanning, rbac.viewRevision], () => listener({ operations: businessBindings.filter(binding => binding.kind === 'read').map(binding => binding.operation) as Array<keyof ReadOperations> }), { deep: true })
    },
  },
}
export const queueService = {
  native: Boolean(nativeQueue),
  context: async () => (await prepareDesktopSession()).contextId,
  list: nativeCommands,
  discardPlan: nativeDiscardPlan,
  review: (operationId: string, contextId: string) => queueRequest<{ operationId: string; local: unknown; server: unknown; status: number; operationIds: string[] }>({ action: 'reviewConflict', operationId, contextId }),
  discard: (operationIds: string[], contextId?: string) => queueRequest({ action: 'discard', operationIds, contextId }),
}
export const pullData = (force = false) => force ? applicationData.sync.pull().then(result => result.status === 'ok') : warmNow()
export const pushChanges = () => applicationData.sync.push().then(() => {})
export const syncEverything = syncAll
export const queueAvailability = legacyQueueAvailability
