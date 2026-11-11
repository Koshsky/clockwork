import type { ArgTypes } from '@storybook/vue3-vite'
import type { BarProps } from './types'

export const barArgTypes: ArgTypes<BarProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  startDate: {
    name: 'Дата начала',
    description: 'Дата начала бара',
    control: 'date',
    table: { type: { summary: 'string | Date | number' }, category: 'Data' },
  },
  endDate: {
    name: 'Дата окончания',
    description: 'Дата окончания бара',
    control: 'date',
    table: { type: { summary: 'string | Date | number' }, category: 'Data' },
  },
  groupStartDate: {
    name: 'Начало границ родителя',
    description: 'Бар не перетаскивается левее этой даты',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
  groupEndDate: {
    name: 'Окончание границ родителя',
    description: 'Бар не перетаскивается правее этой даты',
    control: 'date',
    table: { type: { summary: 'string | Date | number | null' }, category: 'Data' },
  },
  title: {
    name: 'Название',
    description: 'Текст бара и тултипа (по умолчанию — контент слота)',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
  projectCode: {
    name: 'Код проекта',
    description: 'Бейдж после названия',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
  color: {
    name: 'Цвет',
    description: 'Цвет заливки бара',
    control: 'color',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: '#34a853' },
      category: 'Appearance',
    },
  },
  opacity: {
    name: 'Прозрачность',
    description: 'Прозрачность заливки (0–1)',
    control: { type: 'range', min: 0, max: 1, step: 0.05 },
    table: {
      type: { summary: 'number' },
      defaultValue: { summary: '0.75' },
      category: 'Appearance',
    },
  },
  height: {
    name: 'Высота',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '24' }, category: 'Appearance' },
  },
  top: {
    name: 'Отступ сверху',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '1' }, category: 'Appearance' },
  },
  draggable: {
    name: 'Перетаскивание',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'true' },
      category: 'Behavior',
    },
  },
}

export default barArgTypes
