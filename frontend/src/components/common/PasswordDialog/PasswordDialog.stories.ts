import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import PasswordDialog from './PasswordDialog.vue'

const meta: Meta<typeof PasswordDialog> = {
  title: 'Components/Common/PasswordDialog',
  component: PasswordDialog,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    open: { control: 'boolean' },
    password: { control: 'text' },
    caption: { control: 'text' },
  },
  args: {
    open: true,
    caption: 'Пользователь «Иван Петров» создан',
    password: 'R9x3AXmMNLX3Fk8K',
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const GeneratedPassword: Story = {
  tags: ['vitest'],
  play: async ({ canvasElement: _canvasElement, step }) => {
    await step('mount: dialog with a password renders the copy field', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const card = document.body.querySelector<HTMLElement>('.pd-card')
      expect(card).toBeTruthy()
      expect(card?.getAttribute('role')).toBe('dialog')
      const value = card?.querySelector<HTMLElement>('.cf-value')
      expect(value).toBeTruthy()
      expect(value?.textContent).toBe('R9x3AXmMNLX3Fk8K')
      expect(card?.querySelector('.cf-copy')).toBeTruthy()
      // The one-time hint is shown next to a real password.
      expect(card?.textContent).toContain('Пароль показывается один раз')
      // No notice block in password mode.
      expect(card?.querySelector('.pd-note')?.textContent?.includes('Ссылка для сброса')).toBe(false)
    })
  },
}

export const ResetPassword: Story = {
  args: {
    caption: 'Новый пароль для «Иван Петров»',
    password: 'k7Vp2qLmZx9R',
  },
}

export const LongPassword: Story = {
  args: {
    caption: 'Новый пароль для «Александр Смирнов»',
    password: 'aB3dE7fGh9iJkLmN0pQrStUvWxYz123456',
  },
}

/**
 * Test (regression for 4ae6326): with an empty `password` and a `notice` the
 * dialog shows the notice text and NOT the copy field; the copy field is only
 * rendered when a password is present.
 */
export const NoticeOnly: Story = {
  name: 'Notice (no password)',
  tags: ['vitest'],
  args: {
    caption: 'Сброс пароля',
    password: '',
    notice: 'Ссылка для сброса пароля отправлена на почту пользователя.',
  },
  play: async ({ canvasElement: _canvasElement, step }) => {
    await step('mount: the notice text is rendered', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const card = document.body.querySelector<HTMLElement>('.pd-card')
      expect(card).toBeTruthy()
      const note = card?.querySelector('.pd-note')
      expect(note?.textContent).toContain('Ссылка для сброса пароля отправлена на почту пользователя.')
    })

    await step('no copy field and no one-time hint without a password', () => {
      const card = document.body.querySelector<HTMLElement>('.pd-card')
      expect(card?.querySelector('.cf-field')).toBeNull()
      expect(card?.querySelector('.cf-copy')).toBeNull()
      expect(card?.textContent).not.toContain('Пароль показывается один раз')
    })
  },
}