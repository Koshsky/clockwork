import type { ArgTypes } from '@storybook/vue3-vite'
import type { CopyFieldProps } from './types'

export const copyFieldArgTypes: ArgTypes<CopyFieldProps> = {
  value: {
    name: 'Значение',
    description: 'Значение для отображения и копирования',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Data' },
  },
  label: {
    name: 'Подпись',
    description: 'Подпись над полем',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: "''" }, category: 'Content' },
  },
  monospace: {
    name: 'Моноширинный',
    description: 'Моноширинный шрифт (для паролей/логинов)',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, defaultValue: { summary: 'true' }, category: 'Content' },
  },
  copyLabel: {
    name: 'Подпись копирования',
    description: 'Тултип/aria кнопки копирования',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: 'Скопировать' }, category: 'Behavior' },
  },
}

export default copyFieldArgTypes
