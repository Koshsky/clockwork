import type { ArgTypes } from '@storybook/vue3-vite'
import type { ContextMenuProps } from './types'

export const contextMenuArgTypes: ArgTypes<ContextMenuProps> = {
  open: {
    name: 'Видимость',
    description: 'Показывать ли меню',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  x: {
    name: 'X',
    description: 'Горизонтальная позиция меню (clientX)',
    control: 'number',
    table: { type: { summary: 'number' }, category: 'Position' },
  },
  y: {
    name: 'Y',
    description: 'Вертикальная позиция меню (clientY)',
    control: 'number',
    table: { type: { summary: 'number' }, category: 'Position' },
  },
  items: {
    name: 'Пункты меню',
    description: 'Список пунктов: { id, label }',
    control: 'object',
    table: {
      type: { summary: 'ContextMenuItem[]' },
      defaultValue: { summary: '[]' },
      category: 'Content',
    },
  },
}

export default contextMenuArgTypes
