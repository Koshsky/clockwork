/**
 * Short name "Surname I.O." (surname + initials).
 * Built from structured fields (last_name/first_name/middle_name), or, when
 * they are absent, from an existing full-name string ("Surname First Middle").
 * Example: "Ivanov Ivan Ivanovich" → "Ivanov I.I."
 */
export function shortName(u?: {
  name?: string | null
  last_name?: string | null
  first_name?: string | null
  middle_name?: string | null
} | null): string {
  const surname = u?.last_name?.trim() ?? ''
  const first = u?.first_name?.trim() ?? ''
  const middle = u?.middle_name?.trim() ?? ''
  const initial = (value: string): string => {
    const letter = value.match(/\p{L}/u)?.[0]
    return letter ? `${letter.toUpperCase()}.` : ''
  }
  if (surname || first || middle) {
    return [surname, initial(first) + initial(middle)].filter(Boolean).join(' ')
  }
  const [fallbackSurname, ...rest] = (u?.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (!fallbackSurname) return ''
  const initials = rest.map((part) => /^(?:\p{L}\.)+$/u.test(part) ? part : initial(part)).join('')
  return [fallbackSurname, initials].filter(Boolean).join(' ')
}
