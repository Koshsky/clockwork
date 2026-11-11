import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import ContextMenu from './ContextMenu.vue'

const meta: Meta<typeof ContextMenu> = {
  title: 'Components/Common/ContextMenu',
  component: ContextMenu,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

const items = [
  { id: 'task', label: 'Создать задачу' },
  { id: 'milestone', label: 'Создать веху' },
]

export const Open: Story = {
  args: {
    open: true,
    x: 120,
    y: 80,
    items,
  },
}

export const NearRightEdge: Story = {
  args: {
    open: true,
    x: window.innerWidth - 40,
    y: 60,
    items,
  },
}

export const SingleItem: Story = {
  args: {
    open: true,
    x: 100,
    y: 100,
    items: [{ id: 'project', label: 'Создать проект' }],
  },
}

/**
 * Test (regression for 9e0b093-class document listeners): the menu is
 * teleported to <body>; a document click outside emits `close`, Escape closes
 * it, and clicking an item emits `select` with the item id and closes.
 *
 * Unmount-cleanup note: the play model cannot unmount a story mid-test (no
 * @storybook/test `mount` in this repo), so "listeners removed on unmount" is
 * covered here only by the mounted behavior contract (each of the closes is
 * driven by a fresh document event; the open→close cycle repeats cleanly).
 */
export const OutsideClickEscapeAndSelect: Story = {
  name: 'Test: outside click / Escape close, item select, per-instance cycle',
  tags: ['vitest'],
  render: () => ({
    components: { ContextMenu },
    data: () => ({
      open: false,
      selected: '',
      items: [
        { id: 'task', label: 'Создать задачу' },
        { id: 'milestone', label: 'Создать веху' },
      ],
    }),
    template: `
      <div>
        <button type="button" class="cm-open" @click="open = true">Открыть меню</button>
        <ContextMenu :open="open" :x="120" :y="80" :items="items" @select="selected = $event; open = false" @close="open = false" />
        <div data-testid="cm-selected" style="font-size: calc(var(--ui-font-scale, 1) * 12px);">{{ selected }}</div>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const menu = () => document.body.querySelector<HTMLElement>('.cm[role="menu"]')
    const open = async () => {
      ;(canvasElement.querySelector('.cm-open') as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 50))
    }

    await step('open: the menu appears with the items', async () => {
      await open()
      expect(menu()).toBeTruthy()
      const items = [...(menu()?.querySelectorAll('.cm-item') ?? [])]
      expect(items.length).toBe(2)
      expect((items[0] as HTMLElement).textContent).toContain('Создать задачу')
    })

    await step('document click outside emits close — the menu disappears', async () => {
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(menu()).toBeNull()
    })

    await step('open again; Escape closes the menu', async () => {
      await open()
      expect(menu()).toBeTruthy()
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(menu()).toBeNull()
    })

    await step('open again; clicking an item emits select and closes', async () => {
      await open()
      const item = menu()?.querySelector<HTMLButtonElement>('.cm-item:first-child')
      expect(item).toBeTruthy()
      ;(item as HTMLButtonElement).click()
      await new Promise((r) => setTimeout(r, 30))
      expect(canvasElement.querySelector('[data-testid="cm-selected"]')?.textContent).toBe('task')
      expect(menu()).toBeNull()
    })
  },
}
