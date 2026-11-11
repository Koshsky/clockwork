/** Cell/swatch fill color by state (code + availability flag). */

const CODE_COLORS: Record<string, string> = {
  ОТП: '#ffd6a5',
  Б: '#ffb3b3',
  ОТГ: '#d9d9d9',
  К: '#b5d8ff',
  Я: '#dff0ff',
}

const PALETTE = ['#ffe8a3', '#c8e6c9', '#b3e5fc', '#e1bee7', '#ffccbc', '#cfd8dc']

export function stateBackground(
  code: string | undefined,
  isAvailable: boolean | undefined,
  stateID: number | undefined,
): string {
  if (isAvailable) return '#b5d8ff'
  if (code && CODE_COLORS[code]) return CODE_COLORS[code]
  return PALETTE[Number(stateID ?? 0) % PALETTE.length]
}
