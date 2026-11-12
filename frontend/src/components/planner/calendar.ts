export * from '@/domain/calendar'
import { toDate } from '@/domain/calendar'
import { fmtDateRange } from '@/i18n/date'

/**
 * Date range "dd.mm.yyyy — dd.mm.yyyy" (local timezone) for bar tooltips.
 * Locale-aware through src/i18n/date.ts, so it follows the interface language;
 * callers re-render on a language switch (computed/function context).
 */
export function formatDateRange(start: Date | string | number, end: Date | string | number): string {
  return fmtDateRange(toDate(start), toDate(end))
}
