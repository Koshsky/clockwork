import type { Meta, StoryObj } from '@storybook/vue3-vite'
import CopyField from './CopyField.vue'

const meta: Meta<typeof CopyField> = {
  title: 'Components/Common/CopyField',
  component: CopyField,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  argTypes: {
    value: { control: 'text' },
    label: { control: 'text' },
    monospace: { control: 'boolean' },
    copyLabel: { control: 'text' },
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const PasswordValue: Story = {
  args: {
    value: 'R9x3AXmMNLX3Fk8K',
    label: 'Сгенерированный пароль',
  },
}

export const WithLabelAndMono: Story = {
  args: {
    value: 'samakaev',
    label: 'Логин',
  },
}

export const Empty: Story = {
  args: {
    value: '',
    label: 'Пустое значение',
  },
}
