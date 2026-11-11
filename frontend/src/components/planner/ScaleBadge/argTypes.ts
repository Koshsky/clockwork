import type { ArgTypes } from '@storybook/vue3-vite'
import type { ScaleBadgeProps } from './types'

export const scaleBadgeArgTypes: ArgTypes<ScaleBadgeProps> = {
  scale: {
    name: 'Масштаб',
    description: 'Текущий масштаб таблицы (zoom на .tg-content, 0.5–2)',
    control: { type: 'range', min: 0.5, max: 2, step: 0.01 },
    table: { type: { summary: 'number' }, defaultValue: { summary: '1' }, category: 'Data' },
  },
  bump: {
    name: 'Счётчик зумов',
    description: 'Каждый инкремент показывает бейдж на 900 мс (в приложении инкрементирует сама шкала)',
    control: 'number',
    table: { type: { summary: 'number' }, defaultValue: { summary: '0' }, category: 'Data' },
  },
}

export default scaleBadgeArgTypes
