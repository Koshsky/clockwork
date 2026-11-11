import type { ArgTypes } from '@storybook/vue3-vite'
import type { CalendarHeaderProps } from './types'

export const calendarHeaderArgTypes: ArgTypes<CalendarHeaderProps> = {
  t: { control: false, table: { disable: true, category: 'Data' } },
}

export default calendarHeaderArgTypes
