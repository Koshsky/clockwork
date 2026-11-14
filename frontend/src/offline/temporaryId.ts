import { temporaryIdFromEntropy } from '@/domain/temporaryId'

/** Concurrent tabs can create records during the same wall-clock millisecond. */
export function createTemporaryId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return temporaryIdFromEntropy(words[0]!, words[1]!)
}
