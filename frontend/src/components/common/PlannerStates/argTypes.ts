import type { ArgTypes } from '@storybook/vue3-vite'
import type { PlannerStatesProps } from './types'

export const plannerStatesArgTypes: ArgTypes<PlannerStatesProps> = {
  loading: {
    name: 'Загрузка',
    description: 'Показывать состояние «Загрузка...»',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  error: {
    name: 'Ошибка',
    description: 'Текст ошибки (баннер; при отсутствии данных — и по центру)',
    control: 'text',
    table: { type: { summary: 'string | null' }, category: 'Content' },
  },
  hasData: {
    name: 'Есть данные',
    description: 'Рендерить слот (грид) вместо пустого состояния',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, category: 'Behavior' },
  },
  emptyText: {
    name: 'Текст пустого состояния',
    description: 'Надпись, когда данных нет и нет ошибки',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: 'Нет данных' },
      category: 'Content',
    },
  },
}

export default plannerStatesArgTypes
