import type { ArgTypes } from '@storybook/vue3-vite'
import type { ConfirmDialogProps } from './types'

export const confirmDialogArgTypes: ArgTypes<ConfirmDialogProps> = {
  open: {
    name: 'Видимость',
    description: 'Показывать ли диалог',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  title: {
    name: 'Заголовок',
    description: 'Заголовок окна',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: 'Подтверждение' },
      category: 'Content',
    },
  },
  message: {
    name: 'Текст',
    description: 'Текст подтверждения (что именно удаляем)',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
  confirmLabel: {
    name: 'Текст кнопки',
    description: 'Текст кнопки подтверждения',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: 'Удалить' },
      category: 'Content',
    },
  },
  danger: {
    name: 'Опасное действие',
    description: 'Красная кнопка подтверждения',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'true' },
      category: 'Behavior',
    },
  },
}

export default confirmDialogArgTypes
