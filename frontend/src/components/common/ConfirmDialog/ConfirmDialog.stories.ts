import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ConfirmDialog from './ConfirmDialog.vue'

const meta: Meta<typeof ConfirmDialog> = {
  title: 'Components/Common/ConfirmDialog',
  component: ConfirmDialog,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Delete: Story = {
  args: {
    open: true,
    title: 'Подтверждение',
    message: 'Удалить задачу?',
    confirmLabel: 'Удалить',
  },
}

export const DeleteWithWarning: Story = {
  args: {
    open: true,
    title: 'Подтверждение',
    message: 'Удалить процесс? Это удалит все его задачи и вехи.',
    confirmLabel: 'Да, удалить',
  },
}

export const SafeAction: Story = {
  args: {
    open: true,
    title: 'Подтверждение',
    message: 'Завершить редактирование?',
    confirmLabel: 'Да',
    danger: false,
  },
}
