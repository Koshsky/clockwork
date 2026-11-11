import type { ArgTypes } from '@storybook/vue3-vite'
import type { ProcessPlanningProps } from './types'

export const processPlanningArgTypes: ArgTypes<ProcessPlanningProps> = {
  projects: {
    name: 'Проекты',
    description: 'Массив проектов (DTO из /planning/processes) для отображения',
    control: 'object',
    table: { type: { summary: 'DtoDetailedProject[] | null' }, category: 'Data' },
  },
  origin: {
    name: 'Якорь шкалы',
    description: 'Дата-якорь (ячейка с индексом 0); начальная позиция шкалы',
    control: 'date',
    table: { type: { summary: 'string | Date' }, category: 'Data' },
  },
  unit: {
    name: 'Единица ячейки',
    description: 'Сколько дней в одной ячейке шкалы: день или декада',
    control: 'select',
    options: ['day', 'decade'],
    table: { type: { summary: 'PlanningUnit' }, defaultValue: { summary: 'day' }, category: 'Data' },
  },
  loading: {
    name: 'Загрузка',
    control: 'boolean',
    table: { category: 'State' },
  },
  error: {
    name: 'Ошибка',
    control: 'text',
    table: { category: 'State' },
  },
}

export default processPlanningArgTypes
