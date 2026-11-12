export function temporaryIdFromEntropy(high: number, low: number): number {
  return -(1_000_000 + (high & 0xfffff) * 0x100000000 + low)
}
