import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import ModalForm from './ModalForm.vue'
import type { ModalField } from './types'

const meta: Meta<typeof ModalForm> = {
  title: 'Components/Common/ModalForm',
  component: ModalForm,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    open: true,
    title: 'Редактировать проект',
    submitLabel: 'Сохранить',
    busy: false,
  },
}

export default meta
type Story = StoryObj<typeof meta>

const textField = (key: string, label: string, value: string, required = true): ModalField => ({
  key,
  label,
  type: 'text',
  value,
  required,
})

export const SimpleText: Story = {
  args: {
    fields: [
      textField('code', 'Код проекта', 'КО_505-S-ПТЗ_БСМП_МВС'),
    ],
  },
}

export const WithSelect: Story = {
  args: {
    fields: [
      textField('code', 'Код проекта', 'КО_505-S-ПТЗ_БСМП_МВС'),
      {
        key: 'owner_id',
        label: 'Владелец',
        type: 'select',
        value: 2,
        options: [
          { value: 1, label: 'Иванов Иван' },
          { value: 2, label: 'Петров Пётр' },
          { value: 3, label: 'Сидорова Анна' },
        ],
      },
    ],
  },
}

export const WithTextarea: Story = {
  args: {
    title: 'Редактировать веху',
    fields: [
      textField('title', 'Название', 'Сдача объекта'),
      {
        key: 'content',
        label: 'Контент',
        type: 'textarea',
        value: 'Подписание акта ввода в эксплуатацию.',
      },
    ],
  },
}

export const WithDates: Story = {
  args: {
    title: 'Добавить период состояния',
    fields: [
      {
        key: 'state_id',
        label: 'Состояние',
        type: 'select',
        value: '',
        options: [
          { value: 1, label: 'Отпуск' },
          { value: 2, label: 'Больничный' },
          { value: 3, label: 'Командировка' },
        ],
      },
      { key: 'start_date', label: 'Начало', type: 'date', value: '2026-07-20', required: true },
      { key: 'end_date', label: 'Конец', type: 'date', value: '2026-08-02', required: true },
    ],
  },
}

export const Busy: Story = {
  args: {
    busy: true,
    fields: [textField('title', 'Название', 'Новый процесс')],
  },
}

/**
 * Test (regression for 4ae6326/useModalFocus): the dialog traps the focus
 * (Tab cycles inside, Shift+Tab wraps back), Escape emits `close` (the wrapper
 * hides the modal) and the busy guard blocks a second `save` while `busy`.
 * The wrapper starts closed and is opened with a button so `resetValues` seeds
 * the required field (on first mount with open=true the values are not reset).
 */
export const FocusTrapEscapeAndDoubleSubmitGuard: Story = {
  name: 'Test: focus trap, Escape close and busy double-submit guard',
  tags: ['vitest'],
  render: () => ({
    components: { ModalForm },
    data: () => ({
      open: false,
      busy: false,
      saves: 0,
      fields: [textField('title', 'Название', 'Новый процесс')],
    }),
    template: `
      <div>
        <button type="button" class="mf-open" @click="open = true">Открыть форму</button>
        <ModalForm :open="open" :busy="busy" title="Новый процесс" :fields="fields" :submit-label="'Сохранить'" @save="saves += 1; busy = true" @close="open = false" />
        <div data-testid="mf-saves" style="font-size: calc(var(--ui-font-scale, 1) * 12px);">{{ saves }}</div>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const dialog = () => document.body.querySelector<HTMLElement>('.mf')
    const pressOn = async (el: HTMLElement, key: string, shiftKey = false) => {
      el.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
      )
      await new Promise((r) => setTimeout(r, 20))
    }

    await step('mount closed; open via the button', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(dialog()).toBeNull()
      ;(canvasElement.querySelector('.mf-open') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      expect(dialog()).toBeTruthy()
      const card = dialog() as HTMLElement
      expect(card.getAttribute('role')).toBe('dialog')
    })

    await step('initial focus is inside the dialog', async () => {
      const card = dialog() as HTMLElement
      expect(card.contains(document.activeElement)).toBe(true)
    })

    await step('Tab from the last element wraps to the first (trap)', async () => {
      const card = dialog() as HTMLElement
      const save = card.querySelector<HTMLButtonElement>('.mf-save') as HTMLButtonElement
      const close = card.querySelector<HTMLButtonElement>('.mf-close') as HTMLButtonElement
      save.focus()
      await pressOn(save, 'Tab')
      expect(document.activeElement).toBe(close)
    })

    await step('Shift+Tab from the first element wraps to the last (trap)', async () => {
      const card = dialog() as HTMLElement
      const save = card.querySelector<HTMLButtonElement>('.mf-save') as HTMLButtonElement
      const close = card.querySelector<HTMLButtonElement>('.mf-close') as HTMLButtonElement
      close.focus()
      await pressOn(close, 'Tab', true)
      expect(document.activeElement).toBe(save)
    })

    await step('Escape emits close — the modal disappears', async () => {
      const card = dialog() as HTMLElement
      await pressOn(card, 'Escape')
      await new Promise((r) => setTimeout(r, 30))
      expect(dialog()).toBeNull()
    })

    await step('reopen; a submit while busy does not emit a second save', async () => {
      ;(canvasElement.querySelector('.mf-open') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      const card = dialog() as HTMLElement
      const form = card.querySelector<HTMLFormElement>('.mf-form') as HTMLFormElement
      const save = card.querySelector<HTMLButtonElement>('.mf-save') as HTMLButtonElement
      // First submit: saves becomes 1, the wrapper flips busy=true.
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(canvasElement.querySelector('[data-testid="mf-saves"]')?.textContent).toBe('1')
      // Busy: the save button is disabled and a second submit is swallowed.
      expect(save.disabled).toBe(true)
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(canvasElement.querySelector('[data-testid="mf-saves"]')?.textContent).toBe('1')
    })
  },
}
