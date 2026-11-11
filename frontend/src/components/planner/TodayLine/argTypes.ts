import type { ArgTypes } from '@storybook/vue3-vite'
import type { TodayLineProps } from './types'

export const todayLineArgTypes: ArgTypes<TodayLineProps> = {
  timeline: { control: false, table: { disable: true, category: 'Data' } },
  color: {
    name: 'Цвет',
    description: 'Цвет луча текущей даты',
    control: 'color',
    table: { defaultValue: { summary: '#e53935' }, category: 'Appearance' },
  },
  width: {
    name: 'Ширина',
    description: 'Ширина луча (px)',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '2' }, category: 'Appearance' },
  },
  offset: {
    name: 'Смещение',
    description: 'Смещение луча вправо от границы «вчера/сегодня» (px)',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '0' }, category: 'Appearance' },
  },
}

export default todayLineArgTypes
