/** Concurrent tabs can create records during the same wall-clock millisecond. */
export function createTemporaryId(): number {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return -(1_000_000 + (words[0]! & 0xfffff) * 0x100000000 + words[1]!)
}
