import type { ArgTypes } from '@storybook/vue3-vite'
import type { MilestoneMarkerProps } from './types'

export const milestoneMarkerArgTypes: ArgTypes<MilestoneMarkerProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  date: {
    name: 'Дата вехи',
    description: 'Одна дата на шкале — маркер встаёт по центру её ячейки',
    control: 'date',
    table: { category: 'Data' },
  },
  title: {
    name: 'Заголовок',
    description: 'Первая строка тултипа',
    control: 'text',
    table: { category: 'Content' },
  },
  content: {
    name: 'Описание',
    description: 'Вторая строка тултипа (переносится на несколько строк)',
    control: 'text',
    table: { category: 'Content' },
  },
  color: {
    name: 'Цвет',
    control: 'color',
    table: { defaultValue: { summary: '#fbbc04' }, category: 'Appearance' },
  },
  stripHeight: {
    name: 'Высота полосы вех',
    description: 'Высота зоны флажка (px); ниже — луч-древко вниз через задачи',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '20' }, category: 'Appearance' },
  },
  groupStartDate: {
    name: 'Начало границ процесса',
    description: 'Дата начала границ процесса; веху нельзя перетаскивать левее',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
  groupEndDate: {
    name: 'Окончание границ процесса',
    description: 'Дата окончания границ процесса; веху нельзя перетаскивать правее',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
}

export default milestoneMarkerArgTypes
