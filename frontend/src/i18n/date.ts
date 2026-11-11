/**
 * Locale-aware date, time and unit formatting. All user-visible dates in the UI
 * go through these helpers instead of a hardcoded 'ru'/'ru-RU' locale, so a
 * language switch re-renders them: call them inside a computed (they read the
 * reactive `appLocale`) or pass the result through a computed of the caller.
 *
 * English uses en-GB (dd/mm/yyyy, 24-hour clock) to keep the 24-hour convention
 * of the Russian original; switch this single constant to 'en-US' for the
 * 12-hour mm/dd/yyyy variant.
 */
import { currentLocale, type AppLocale } from './index'

/** BCP-47 locale used by Intl per interface language. */
export const INTL_LOCALES: Record<AppLocale, string> = {
  ru: 'ru-RU',
  en: 'en-GB',
}

/** Intl locale for the given (or the current) interface language. */
export function dateLocale(locale: AppLocale = currentLocale()): string {
  return INTL_LOCALES[locale]
}

/** Date value accepted by the helpers (Date, ISO string, timestamp). */
export type DateInput = Date | string | number | null | undefined

/** Parses a date value; an invalid/empty input yields null. */
export function toDateValue(value: DateInput): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Short date (ru: 05.11.2026, en: 05/11/2026); an empty input yields ''. */
export function fmtDate(value: DateInput, locale: AppLocale = currentLocale()): string {
  const d = toDateValue(value)
  return d ? d.toLocaleDateString(dateLocale(locale)) : ''
}

/** Date and time (ru: 05.11.2026, 14:30, en: 05/11/2026, 14:30). */
export function fmtDateTime(value: DateInput, locale: AppLocale = currentLocale()): string {
  const d = toDateValue(value)
  return d ? d.toLocaleString(dateLocale(locale)) : ''
}

/** Time only (HH:MM). */
export function fmtTime(value: DateInput, locale: AppLocale = currentLocale()): string {
  const d = toDateValue(value)
  return d ? d.toLocaleTimeString(dateLocale(locale), { hour: '2-digit', minute: '2-digit' }) : ''
}

/** Long month name of a date (ru: «ноябрь», en: «November»). */
export function fmtMonthLong(value: DateInput, locale: AppLocale = currentLocale()): string {
  const d = toDateValue(value)
  return d ? d.toLocaleDateString(dateLocale(locale), { month: 'long' }) : ''
}

/** Date range as a single string (`start — end`); an empty side is skipped. */
export function fmtDateRange(from: DateInput, to: DateInput, locale: AppLocale = currentLocale()): string {
  const a = fmtDate(from, locale)
  const b = fmtDate(to, locale)
  if (a && b) return `${a} — ${b}`
  return a || b
}

/**
 * Short weekday names indexed by `Date.getDay()` (0 = Sunday), derived from Intl
 * so the calendar header follows the interface language instead of a hardcoded
 * RU list.
 */
export function weekdayShort(locale: AppLocale = currentLocale()): string[] {
  const fmt = new Intl.DateTimeFormat(dateLocale(locale), { weekday: 'short' })
  // 2024-01-07 is a Sunday, so index i maps to getDay() === i.
  const sunday = Date.UTC(2024, 0, 7)
  return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(sunday + i * 86_400_000)))
}
