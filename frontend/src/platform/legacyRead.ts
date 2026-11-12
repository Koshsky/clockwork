import { replayOutboxToCache } from '@/offline/outbox'
import { platformCapabilities } from './context'
import { localDataAvailability } from './state'

// Read adapters still use the legacy overlay until stage 05. A web GET cache
// is optional; inability to read the queue never acknowledges or deletes work.
export async function prepareCacheOverlay(): Promise<void> {
  if (platformCapabilities.optionalStorage && localDataAvailability.value === 'unavailable') return
  try { await replayOutboxToCache() } catch (error) {
    if (!platformCapabilities.optionalStorage || localDataAvailability.value !== 'unavailable') throw error
  }
}
