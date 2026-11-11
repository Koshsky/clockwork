import type { ArgTypes } from '@storybook/vue3-vite'
import type { TaskPlanningProps } from './types'

export const taskPlanningArgTypes: ArgTypes<TaskPlanningProps> = {
  processes: {
    name: 'Процессы',
    description: 'Набор процессов (DTO из /planning/tasks) для отображения',
    control: 'object',
    table: {
      type: { summary: 'DtoDetailedProcess[] | null' },
      defaultValue: { summary: 'null' },
      category: 'Data',
    },
  },
  resources: {
    name: 'Ресурсы',
    description: 'Набор ресурсов',
    control: 'object',
    table: {
      type: { summary: 'DtoResource[] | null' },
      defaultValue: { summary: 'null' },
      category: 'Data',
    },
  },
  origin: {
    name: 'Якорь шкалы',
    description: 'Дата-якорь (ячейка с индексом 0); начальная позиция шкалы',
    control: 'date',
    table: {
      type: { summary: 'string | Date' },
      category: 'Data',
    },
  },
  unit: {
    name: 'Единица ячейки',
    description: 'Сколько дней в одной ячейке шкалы: день или декада',
    control: 'select',
    options: ['day', 'decade'],
    table: {
      type: { summary: 'PlanningUnit' },
      defaultValue: { summary: 'day' },
      category: 'Data',
    },
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

export default taskPlanningArgTypes
