import type { ArgTypes } from '@storybook/vue3-vite'

export default {
  open: {
    control: { type: 'boolean' },
    description: 'Показывать диалог журнала изменений по центру экрана',
    table: { defaultValue: { summary: 'false' } },
  },
} satisfies ArgTypes