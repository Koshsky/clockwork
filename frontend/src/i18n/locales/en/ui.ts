import type ru from '../ru/ui'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/ui.ts. */
export default {
  color: {
    label: 'Color',
    titleChange: '{value} — change color',
    titleEmpty: 'No color — pick a color',
    ariaWithLabel: 'Color — {label}',
    ariaSwatch: 'Color {value}',
    none: 'No color',
    paletteTitle: 'Flexible palette',
    paletteOpen: 'Open the flexible palette',
  },
  dataTable: {
    resizeColumn: 'Resize column',
  },
  hint: {
    aria: 'Hint: {label}',
    close: 'Close hint',
  },
  password: {
    minLength: '8 to 64 characters',
    letter: 'at least one letter',
    digit: 'at least one digit',
    dialogShownOnce: 'The password is shown once. Copy it and give it to the user.',
    show: 'Show password',
    hide: 'Hide password',
  },
  pending: {
    title: 'The change is waiting to be sent to the server',
  },
  states: {
    loading: 'Loading...',
  },
  resource: {
    total: 'Total: {count}',
  },
  usage: {
    normal: 'Normal',
    warn: 'Overload',
    critical: 'Critical',
    weekend: 'Day off',
    absencesTitle: 'Absent:',
  },
} satisfies Translation<typeof ru>
