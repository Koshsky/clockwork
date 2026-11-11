import type { ArgTypes } from '@storybook/vue3-vite'
import type { ProcessGanttProps } from './types'

export const processGanttArgTypes: ArgTypes<ProcessGanttProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  projectCode: {
    name: 'Код проекта',
    control: 'text',
    table: { category: 'Content' },
  },
  projectId: {
    name: 'Идентификатор проекта',
    description: 'ID проекта-родителя (для создания процессов в группе)',
    control: 'number',
    table: { type: { summary: 'number' }, category: 'Data' },
  },
  processes: {
    name: 'Процессы (задачи)',
    description: 'Массив задач в рамках процесса',
    control: 'object',
    table: { type: { summary: 'ProcessItem[]' }, category: 'Data' },
  },
  groupStartDate: {
    name: 'Начало проекта',
    control: 'text',
    table: { category: 'Границы' },
  },
  groupEndDate: {
    name: 'Конец проекта',
    control: 'text',
    table: { category: 'Границы' },
  },
}

export default processGanttArgTypes
