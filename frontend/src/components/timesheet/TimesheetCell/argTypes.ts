import type { ArgTypes } from '@storybook/vue3-vite'
import type { TimesheetCellProps } from './types'

export const timesheetCellArgTypes: ArgTypes<TimesheetCellProps> = {
  state: {
    name: 'Состояние',
    description: 'Период состояния, покрывающий день (null — рабочий день)',
    control: 'object',
    table: { type: { summary: 'DtoUserStateResponse | null' }, category: 'Data' },
  },
  colorMap: {
    name: 'Карта цветов',
    description: 'Состояние id → пользовательский цвет (заливка ячейки и маркер)',
    control: 'object',
    table: { type: { summary: 'Record<number, string>' }, category: 'Data' },
  },
  isWeekend: {
    name: 'Выходной',
    description: 'Выходной день (светло-серая заливка, если нет состояния)',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Data' },
  },
  selected: {
    name: 'Выделено',
    description: 'Ячейка попала в выделение диапазона',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Data' },
  },
  showText: {
    name: 'Код состояния',
    description: 'Показывать код состояния в широких ячейках',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Data' },
  },
}

export default timesheetCellArgTypes
