import type { ArgTypes } from '@storybook/vue3-vite'
import type { PasswordRequirementsProps } from './types'
import { passwordRules } from '../../../composables/usePasswordValidation'

export const passwordRequirementsArgTypes: ArgTypes<PasswordRequirementsProps> = {
  modelValue: {
    name: 'Значение',
    description: 'Пароль для проверки',
    control: 'text',
    table: { type: { summary: 'string' }, defaultValue: { summary: "''" }, category: 'Data' },
  },
  rules: {
    name: 'Правила',
    description: 'Список правил (id, label, test)',
    control: 'object',
    table: {
      type: { summary: 'PasswordRule[]' },
      defaultValue: { summary: 'passwordRules()' },
      category: 'Content',
    },
  },
  showIdle: {
    name: 'Показывать в покое',
    description: 'Подсвечивать правила выполненными, когда все пройдены',
    control: 'boolean',
    table: { type: { summary: 'boolean' }, defaultValue: { summary: 'true' }, category: 'Behavior' },
  },
}

export default passwordRequirementsArgTypes

// Re-export for Storybook so the default rules are real ones
export { passwordRules }
