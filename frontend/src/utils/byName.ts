/** Compares users by full name (name), ru locale, ascending */
export function compareByName(a: { name?: string | null }, b: { name?: string | null }): number {
  return (a.name ?? '').localeCompare(b.name ?? '', 'ru')
}
