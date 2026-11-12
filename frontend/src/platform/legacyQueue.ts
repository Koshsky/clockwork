import { replayOutboxToCache } from '@/offline/outbox'
import { syncNow } from '@/offline/sync'

// Temporary compatibility for existing browser work; it must not be mistaken
// for a new web outbox or removed before the explicit migration in stage 16.
export function legacyQueueRecovery() {
  return { prepare: replayOutboxToCache, push: syncNow }
}
