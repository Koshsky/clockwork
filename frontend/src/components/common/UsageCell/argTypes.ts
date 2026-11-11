import type { ArgTypes } from '@storybook/vue3-vite'
import type { UsageCellProps } from './types'

export const usageCellArgTypes: ArgTypes<UsageCellProps> = {
  used: {
    name: 'Занято',
    description: 'Сколько ресурса уже занято',
    control: { type: 'number', min: 0, max: 10 },
    table: { type: { summary: 'number' }, category: 'Data' },
  },
  available: {
    name: 'Доступно',
    description: 'Сколько ресурса доступно (из /timesheet/calendar); null — нет данных',
    control: { type: 'number', min: 1, max: 10 },
    table: { type: { summary: 'number | null' }, category: 'Data' },
  },
  isWeekend: {
    name: 'Выходной',
    description: 'Является ли день выходным (нерабочим)',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Data' },
  },
}

export default usageCellArgTypes
