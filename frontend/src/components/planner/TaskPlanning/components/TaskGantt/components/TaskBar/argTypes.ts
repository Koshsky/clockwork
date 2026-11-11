import type { ArgTypes } from '@storybook/vue3-vite'
import type { TaskBarProps } from './types'

export const taskBarArgTypes: ArgTypes<TaskBarProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  task: {
    name: 'Задача',
    description: 'Объект задачи с датами и ресурсами',
    control: 'object',
    table: {
      type: { summary: 'Task' },
      category: 'Data',
    },
  },
  groupStartDate: {
    name: 'Начало границ процесса',
    description: 'Дата начала границ процесса; задачу нельзя перетаскивать левее',
    control: 'date',
    table: {
      type: { summary: 'string | Date | number | null' },
      category: 'Data',
    },
  },
  groupEndDate: {
    name: 'Окончание границ процесса',
    description: 'Дата окончания границ процесса; задачу нельзя перетаскивать правее',
    control: 'date',
    table: {
      type: { summary: 'string | Date | number | null' },
      category: 'Data',
    },
  },
}

export default taskBarArgTypes
