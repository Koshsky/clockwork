import type { Meta, StoryObj } from '@storybook/vue3-vite'
import PasswordRequirements from './PasswordRequirements.vue'
import { passwordRules } from '../../../composables/usePasswordValidation'

const meta: Meta<typeof PasswordRequirements> = {
  title: 'Components/Common/PasswordRequirements',
  component: PasswordRequirements,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Idle: Story = {
  args: {
    modelValue: '',
    rules: passwordRules(),
  },
}

export const Partial: Story = {
  args: {
    modelValue: 'Pass1',
    rules: passwordRules(),
  },
}

export const Valid: Story = {
  args: {
    modelValue: 'S3cret!pass',
    rules: passwordRules(),
  },
}
