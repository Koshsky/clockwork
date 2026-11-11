import type ru from '../ru/dates'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/dates.ts. */
export default {
  seconds: '{n} s',
  minutes: '{n} min',
  hours: '{n} h',
  days: '{n} d',
} satisfies Translation<typeof ru>
