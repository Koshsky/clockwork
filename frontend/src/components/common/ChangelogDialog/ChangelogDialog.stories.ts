import type { Meta, StoryObj } from '@storybook/vue3-vite'
import type { ConcreteComponent } from 'vue'
import { ref } from 'vue'
import { expect } from 'storybook/test'
import ChangelogDialog from './ChangelogDialog.vue'
import changelogArgTypes from './argTypes'

const meta: Meta = {
  title: 'Components/Common/ChangelogDialog',
  component: ChangelogDialog as unknown as ConcreteComponent,
  argTypes: changelogArgTypes,
  tags: ['autodocs'],
}

export default meta

/** Журнал изменений: центрированный диалог со скруглёнными углами и прокруткой. */
export const Open: StoryObj = {
  render: () => ({
    components: { ChangelogDialog },
    setup: () => ({ open: ref(true) }),
    template: '<ChangelogDialog :open="open" @close="open = false" />',
  }),
}

/** Закрытие: ✕, Esc, клик по подложке. */
export const Interaction: StoryObj = {
  tags: ['vitest'],
  render: () => ({
    components: { ChangelogDialog },
    setup() {
      const open = ref(false)
      const log = ref<string[]>([])
      return {
        open,
        log,
        openDialog: () => {
          log.value.push('open')
          open.value = true
        },
        onClose: () => {
          log.value.push('close')
          open.value = false
        },
      }
    },
    template:
      '<button type="button" data-testid="open-btn" @click="openDialog">Открыть журнал</button>' +
      '<ChangelogDialog :open="open" @close="onClose" />' +
      '<p data-testid="log">{{ log.join(",") }}</p>',
  }),
  play: async ({ canvasElement, step }) => {
    // The dialog is teleported to <body> — search the document, not the canvas.
    const card = () => document.querySelector<HTMLElement>('.cdlg-card')
    const overlay = () => document.querySelector<HTMLElement>('.cdlg-overlay')
    const btn = () => canvasElement.querySelector<HTMLElement>('[data-testid="open-btn"]')!
    const log = () => canvasElement.querySelector<HTMLElement>('[data-testid="log"]')!.textContent ?? ''

    await step('opens from the trigger and shows the changelog content', async () => {
      btn().click()
      await new Promise((r) => setTimeout(r, 30))
      expect(card()).toBeTruthy()
      expect(card()!.textContent).toContain('Журнал изменений')
      expect(card()!.textContent).toContain('Changelog')
    })

    await step('Escape closes the dialog', async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(card()).toBeNull()
      expect(log()).toContain('close')
    })

    await step('backdrop click closes the dialog', async () => {
      btn().click()
      await new Promise((r) => setTimeout(r, 30))
      expect(card()).toBeTruthy()
      overlay()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 30))
      expect(card()).toBeNull()
    })
  },
}

/**
 * The dialog shows the changelog of the interface language: Changelog_ENG.md
 * for English, Changelog_RU.md otherwise (Russian is the fallback). The switch
 * is reactive, so an already-open dialog re-renders.
 */
export const LocalizedContent: StoryObj = {
  tags: ['vitest'],
  render: () => ({
    components: { ChangelogDialog },
    setup: () => ({ open: ref(true) }),
    template: '<ChangelogDialog :open="open" @close="open = false" />',
  }),
  play: async ({ step }) => {
    const { setAppLocale } = await import('../../../i18n')
    const card = () => document.querySelector<HTMLElement>('.cdlg-card')

    try {
      await step('the default content is the Russian changelog', async () => {
        await new Promise((r) => setTimeout(r, 30))
        expect(card()!.textContent).toContain('Добавлено')
        expect(card()!.textContent).not.toContain('Notable changes')
      })

      await step('switching to English re-renders the dialog with Changelog_ENG.md', async () => {
        setAppLocale('en')
        await new Promise((r) => setTimeout(r, 30))
        expect(card()!.textContent).toContain('Added')
        expect(card()!.textContent).not.toContain('Добавлено')
        expect(card()!.textContent).toContain('Changelog')
      })
    } finally {
      setAppLocale('ru')
    }
  },
}
