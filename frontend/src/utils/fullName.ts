/** Full name "Surname First Middle" from the user's structured fields */
export function fullName(u?: {
  last_name?: string | null
  first_name?: string | null
  middle_name?: string | null
} | null): string {
  return [u?.last_name, u?.first_name, u?.middle_name].filter(Boolean).join(' ')
}
