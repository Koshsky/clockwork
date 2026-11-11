import type { ArgTypes } from '@storybook/vue3-vite'
import { APP_ICONS, type AppIconProps } from './types'

export const appIconArgTypes: ArgTypes<AppIconProps> = {
  name: {
    name: 'Иконка',
    description: 'Название иконки из набора',
    control: 'select',
    options: Object.keys(APP_ICONS),
    table: {
      type: { summary: 'AppIconName' },
      defaultValue: { summary: 'menu' },
      category: 'Content',
    },
  },
  size: {
    name: 'Размер',
    description: 'Размер иконки в пикселях',
    control: { type: 'number', min: 12, max: 32, step: 1 },
    table: {
      type: { summary: 'number' },
      defaultValue: { summary: '18' },
      category: 'Appearance',
    },
  },
}

export default appIconArgTypes