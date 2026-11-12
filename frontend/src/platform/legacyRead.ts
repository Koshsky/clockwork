import { replayOutboxToCache } from '@/offline/outbox'
import { platformCapabilities } from './context'

export async function prepareCacheOverlay(): Promise<void> {
  if (platformCapabilities.optionalStorage) return
  await replayOutboxToCache()
}
