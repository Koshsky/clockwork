import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import AppHeader from './AppHeader.vue'

const meta: Meta<typeof AppHeader> = {
  title: 'Components/Common/AppHeader',
  component: AppHeader,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

/**
 * The language switch is a plain toggle (two languages only): it flips the
 * interface to the other locale and leaves it there — nothing to open, nothing
 * to confirm. The story ends back in Russian, the locale every other story
 * expects.
 */
export const LanguageToggle: Story = {
  tags: ['vitest'],
  play: async ({ canvasElement, step }) => {
    const { setAppLocale, t } = await import('../../../i18n')

    const toggle = () =>
      canvasElement.querySelector<HTMLButtonElement>(`button[aria-label="${t('header.languageAria')}"]`)
    const wait = () => new Promise((r) => setTimeout(r, 30))

    try {
      await step('the header starts in Russian', async () => {
        expect(toggle()).toBeTruthy()
        expect(document.documentElement.lang).toBe('ru')
      })

      await step('a click flips the interface to English', async () => {
        toggle()!.click()
        await wait()
        expect(document.documentElement.lang).toBe('en')
        expect(canvasElement.textContent).toContain('Profile')
        expect(toggle()?.getAttribute('aria-label')).toBe('Switch language')
      })

      await step('a second click returns to Russian', async () => {
        toggle()!.click()
        await wait()
        expect(document.documentElement.lang).toBe('ru')
        expect(canvasElement.textContent).toContain('Профиль')
        expect(toggle()?.getAttribute('aria-label')).toBe('Переключить язык')
      })
    } finally {
      // The locale is app-wide state: never leak English into the next story.
      setAppLocale('ru')
    }
  },
}
