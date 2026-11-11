import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import ColorField from './ColorField.vue'

const meta: Meta<typeof ColorField> = {
  title: 'Components/Common/ColorField',
  component: ColorField,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  argTypes: {
    modelValue: {
      name: 'Цвет',
      description: 'Текущий цвет (#RRGGBB) или пустая строка — стандартный цвет',
      control: 'color',
    },
    label: {
      name: 'Подпись',
      description: 'Подпись поля (aria-label и заголовок панели)',
      control: 'text',
    },
    size: {
      name: 'Размер',
      description: 'Размер кружка-триггера и квадратиков палитры',
      control: { type: 'select' },
      options: ['sm', 'md'],
    },
  },
  args: {
    modelValue: '#3B82F6',
    label: 'Цвет проекта',
    size: 'md',
  },
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

export const WithoutColor: Story = {
  args: {
    modelValue: '',
    label: 'Цвет (стандартный)',
    size: 'md',
  },
}

export const SmallInline: Story = {
  args: {
    modelValue: '#22C55E',
    label: 'Цвет',
    size: 'sm',
  },
}

/**
 * Test (regression for 9e0b093-class document listeners): the palette panel is
 * teleported to <body>; a document click outside closes it, Escape closes it,
 * selecting a swatch emits `update:modelValue` with the swatch color (hex from
 * its `title`) and closes, and "Без цвета" clears the value.
 *
 * Unmount-cleanup note: the play model cannot unmount a story mid-test (no
 * @storybook/test `mount` in this repo), so "listeners removed on unmount" is
 * covered here only by the mounted behavior contract (repeated open/close
 * cycles driven by fresh document events stay clean).
 */
export const OutsideClickEscapeAndSelect: Story = {
  name: 'Test: outside click / Escape close, swatch select and clear',
  tags: ['vitest'],
  render: () => ({
    components: { ColorField },
    data: () => ({
      color: '#3B82F6',
    }),
    template: `
      <div>
        <ColorField :model-value="color" label="Цвет проекта" @update:model-value="color = $event" />
        <div data-testid="cf-value" style="font-size: calc(var(--ui-font-scale, 1) * 12px);">{{ color }}</div>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const panel = () => document.body.querySelector<HTMLElement>('.cf-panel')
    const trigger = () => canvasElement.querySelector<HTMLButtonElement>('.cf-trigger')
    const displayed = () =>
      canvasElement.querySelector('[data-testid="cf-value"]')?.textContent ?? ''

    await step('mount: the trigger is rendered, the panel is closed', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(trigger()).toBeTruthy()
      expect(panel()).toBeNull()
    })

    await step('clicking the trigger opens the palette panel', async () => {
      ;(trigger() as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      expect(panel()).toBeTruthy()
      expect(panel()?.querySelectorAll('.cf-swatch').length).toBeGreaterThan(0)
    })

    await step('document click outside closes the panel', async () => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(panel()).toBeNull()
    })

    await step('open again; Escape closes the panel', async () => {
      ;(trigger() as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      expect(panel()).toBeTruthy()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(panel()).toBeNull()
    })

    await step('selecting a swatch emits update:modelValue and closes', async () => {
      ;(trigger() as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      const swatch = panel()?.querySelector<HTMLButtonElement>('.cf-swatch') as HTMLButtonElement
      const hex = swatch.getAttribute('title')
      swatch.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(displayed()).toBe(hex)
      expect(panel()).toBeNull()
    })

    await step('"Без цвета" clears the value and closes', async () => {
      ;(trigger() as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
      const clear = panel()?.querySelector<HTMLButtonElement>('.cf-clear') as HTMLButtonElement
      clear.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(displayed()).toBe('')
      expect(panel()).toBeNull()
    })
  },
}