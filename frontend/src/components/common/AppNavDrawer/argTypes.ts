import type { ArgTypes } from '@storybook/vue3-vite'
import type { AppNavDrawerProps } from './types'

export const appNavDrawerArgTypes: ArgTypes<AppNavDrawerProps> = {
  open: {
    name: 'Открыта',
    description: 'Видимость панели',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  categories: {
    name: 'Категории',
    description: 'Категории навигации (уже отфильтрованные по правам)',
    table: { type: { summary: 'NavCategory[]' }, category: 'Content' },
  },
  activeName: {
    name: 'Активный маршрут',
    description: 'Имя активного маршрута (подсветка пункта и группы)',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
  brand: {
    name: 'Бренд',
    description: 'Название системы в шапке панели',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: 'MVS ERP' },
      category: 'Content',
    },
  },
}

export default appNavDrawerArgTypes