import type { ArgTypes } from '@storybook/vue3-vite'
import type { TimesheetGridProps } from './types'

export const timesheetGridArgTypes: ArgTypes<TimesheetGridProps> = {
  t: { control: false, table: { disable: true, category: 'Data' } },
  employees: {
    name: 'Сотрудники',
    description: 'Список сотрудников (строки сетки)',
    control: 'object',
    table: { type: { summary: 'DtoUserResponse[]' }, category: 'Data' },
  },
  states: {
    name: 'Состояния',
    description: 'Справочник состояний (панель назначения)',
    control: 'object',
    table: { type: { summary: 'DtoStateResponse[]' }, category: 'Data' },
  },
  colorMap: {
    name: 'Карта цветов',
    description: 'Состояние id → пользовательский цвет (свотчи и ячейки)',
    control: 'object',
    table: { type: { summary: 'Record<number, string>' }, category: 'Data' },
  },
  stateForDay: {
    name: 'Состояние на день',
    description: 'Функция: состояние сотрудника на конкретный день',
    control: false,
    table: { type: { summary: '(employeeId, iso) => DtoUserStateResponse | undefined' }, category: 'Logic' },
  },
  error: {
    name: 'Ошибка',
    description: 'Текст ошибки загрузки/сохранения',
    control: 'text',
    table: { type: { summary: 'string | null' }, category: 'Data' },
  },
  busy: {
    name: 'Сохранение',
    description: 'Идёт сохранение — панель назначения заблокирована',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Data' },
  },
}

export default timesheetGridArgTypes
