import type { PasswordRule } from '../../../composables/usePasswordValidation'

export interface PasswordRequirementsProps {
  modelValue?: string
  rules?: PasswordRule[]
  showIdle?: boolean
}
