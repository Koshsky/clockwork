import type { ArgTypes } from '@storybook/vue3-vite'
import type { PasswordDialogProps } from './types'

export const passwordDialogArgTypes: ArgTypes<PasswordDialogProps> = {
  open: {
    name: 'Открыт',
    description: 'Видимость диалога',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, defaultValue: { summary: 'false' }, category: 'State' },
  },
  password: {
    name: 'Пароль',
    description: 'Пароль для отображения и копирования',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Data' },
  },
  caption: {
    name: 'Заголовок',
    description: 'Заголовок, например «Пользователь создан» или «Новый пароль»',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
}

export default passwordDialogArgTypes