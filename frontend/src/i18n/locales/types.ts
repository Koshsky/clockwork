/**
 * Shared typing helpers for the message catalogs. The Russian catalog is the
 * source of truth (see locales/ru), so every English domain file is checked
 * against its Russian counterpart with `satisfies Translation<typeof ru…>`:
 * a missing or extra key fails `npm run check`, and an untranslated value is
 * still allowed to be an empty string only where the Russian text is used
 * verbatim (brand names, codes — the key-completeness test covers the rest).
 *
 * Catalogs are split by domain (`locales/<locale>/<domain>.ts`) instead of one
 * flat file: with ~700 user-visible strings a single file is unmaintainable,
 * and the domain split mirrors the app areas of the rollout.
 */

/** Maps a Russian catalog shape onto "same keys, string values". */
export type Translation<T> = {
  [K in keyof T]: T[K] extends string ? string : T[K] extends object ? Translation<T[K]> : never
}
