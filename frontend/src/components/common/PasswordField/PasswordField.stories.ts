import type { Meta, StoryObj } from '@storybook/vue3-vite'
import PasswordField from './PasswordField.vue'
import { passwordFieldArgTypes } from './argTypes'

const meta: Meta<typeof PasswordField> = {
  title: 'Components/Common/PasswordField',
  component: PasswordField,
  argTypes: passwordFieldArgTypes,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    label: 'Пароль',
    placeholder: '••••••••',
    modelValue: '',
  },
}

export const WithoutToggle: Story = {
  args: {
    label: 'Пароль без переключателя',
    toggle: false,
  },
}

export const WithValue: Story = {
  args: {
    label: 'Пароль',
    modelValue: 'S3cret!pass',
  },
}
