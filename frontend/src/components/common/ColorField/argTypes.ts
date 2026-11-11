import type { ArgTypes } from '@storybook/vue3-vite'
import type { ColorFieldProps } from './types'

export const colorFieldArgTypes: ArgTypes<ColorFieldProps> = {
  modelValue: {
    name: 'Цвет',
    description: 'Текущий цвет (#RRGGBB) или пустая строка — стандартный цвет',
    control: 'color',
    table: { category: 'Data' },
  },
  label: {
    name: 'Подпись',
    description: 'Подпись поля (aria-label и заголовок панели)',
    control: 'text',
    table: { category: 'Data' },
  },
  size: {
    name: 'Размер',
    description: 'Размер кружка-триггера и квадратиков палитры',
    control: { type: 'select' },
    options: ['sm', 'md'],
    table: { category: 'Appearance' },
  },
}

export default colorFieldArgTypes