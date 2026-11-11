import type { ArgTypes } from '@storybook/vue3-vite'
import type { ProcessBarProps } from './types'

export const processBarArgTypes: ArgTypes<ProcessBarProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  title: {
    name: 'Название процесса',
    control: 'text',
    table: { category: 'Content' },
  },
  projectCode: {
    name: 'Код проекта',
    control: 'text',
    table: { category: 'Content' },
  },
  startDate: {
    name: 'Дата начала',
    control: 'date',
    table: { category: 'Data' },
  },
  endDate: {
    name: 'Дата окончания',
    control: 'date',
    table: { category: 'Data' },
  },
  groupStartDate: {
    name: 'Начало границ проекта',
    description: 'Дата начала границ проекта; процесс нельзя перетаскивать левее',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
  groupEndDate: {
    name: 'Окончание границ проекта',
    description: 'Дата окончания границ проекта; процесс нельзя перетаскивать правее',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
  color: {
    name: 'Цвет',
    control: 'color',
    table: { defaultValue: { summary: '#1a73e8' }, category: 'Appearance' },
  },
  opacity: {
    name: 'Прозрачность',
    control: { type: 'range', min: 0, max: 1, step: 0.05 },
    table: { defaultValue: { summary: '0.85' }, category: 'Appearance' },
  },
}

export default processBarArgTypes
