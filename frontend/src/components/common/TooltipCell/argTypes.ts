import type { ArgTypes } from '@storybook/vue3-vite'
import type { TooltipCellProps } from './types'

export const tooltipCellArgTypes: ArgTypes<TooltipCellProps> = {
  text: {
    name: 'Текст подсказки',
    description: 'Текст, отображаемый во всплывающей подсказке',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: '—' },
      category: 'Content',
    },
  },
  multiline: {
    name: 'Многострочный режим',
    description: 'Переносить текст по строкам (white-space: normal, max-width)',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Appearance',
    },
  },
}

export default tooltipCellArgTypes
