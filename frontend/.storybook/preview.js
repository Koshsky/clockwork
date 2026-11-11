import '../src/styles/tokens.css'
import { setup } from '@storybook/vue3'
import { createRouter, createMemoryHistory } from 'vue-router'
import { createPinia } from 'pinia'
import { i18n, setAppLocale } from '../src/i18n'
import { withCustomTheme } from './decorators/withCustomTheme'
import { withColorScheme } from './decorators/withColorScheme'

/**
 * Real app-level setup for every story: a memory router (so RouterLink /
 * useRoute / useRouter and navigation links render) plus Pinia (stores).
 * The same instance is shared by all stories; the catch-all route keeps any
 * RouterLink `to` valid.
 */
const storyRouter = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
})

setup((app) => {
  app.use(storyRouter)
  app.use(createPinia())
  app.use(i18n)
})

/**
 * Stories run in Russian: the interface-language setting defaults to "auto",
 * which resolves to English inside the Playwright chromium, so without pinning
 * the locale every story would render in English. A story that exercises the
 * language switcher sets the locale itself.
 */
setAppLocale('ru')

/** @type { import('@storybook/vue3-vite').Preview } */
const preview = {
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },
  },

  globalTypes: {
    theme: {
      name: 'Тема оформления',
      description: 'Глобальная тема для компонентов',
      defaultValue: 'default',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'default', title: 'Стандартная' },
          { value: 'compact', title: 'Компактная' },
          { value: 'minimal', title: 'Минималистичная' },
        ],
      },
    },
    scheme: {
      name: 'Цветовая схема',
      description: 'Светлая или тёмная схема',
      defaultValue: 'light',
      toolbar: {
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Светлая', icon: 'sun' },
          { value: 'dark', title: 'Тёмная', icon: 'moon' },
        ],
      },
    },
  },

  decorators: [withCustomTheme, withColorScheme],
}

export default preview