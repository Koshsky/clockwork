import type { ArgTypes } from '@storybook/vue3-vite'
import type { PasswordFieldProps } from './types'

export const passwordFieldArgTypes: ArgTypes<PasswordFieldProps> = {
  modelValue: {
    name: 'Значение',
    description: 'Текущее значение пароля',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: "''" }, category: 'Data' },
  },
  label: {
    name: 'Подпись',
    description: 'Подпись над полем',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: "''" }, category: 'Content' },
  },
  placeholder: {
    name: 'Плейсхолдер',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: '••••••••' }, category: 'Content' },
  },
  autocomplete: {
    name: 'Autocomplete',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: 'new-password' }, category: 'Behavior' },
  },
  toggle: {
    name: 'Переключатель видимости',
    description: 'Показывать кнопку показать/скрыть пароль',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, defaultValue: { summary: 'true' }, category: 'Behavior' },
  },
  id: {
    name: 'ID',
    description: 'id инпута (для label)',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: "''" }, category: 'Attribute' },
  },
}

export default passwordFieldArgTypes
