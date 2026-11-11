import type { Decorator } from '@storybook/vue3-vite'

export type ColorScheme = 'light' | 'dark'

export const withColorScheme: Decorator = (story, context) => {
  const scheme: ColorScheme = (context.globals.scheme as ColorScheme) || 'light'

  return {
    components: { story },
    setup() {
      // Tokens (tokens.css) drive all colors: applying the scheme to <html>
      // via data-scheme is enough for light/dark pairs.
      document.documentElement.dataset.scheme = scheme
      return {}
    },
    template: `
      <div :style="{ padding: '16px', minHeight: '100vh' }">
        <story />
      </div>
    `,
  }
}

export default withColorScheme