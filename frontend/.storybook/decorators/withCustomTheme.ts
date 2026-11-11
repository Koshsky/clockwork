import type { Decorator } from '@storybook/vue3-vite'

export const withCustomTheme: Decorator = (story, context) => {
  const theme = context.globals.theme || 'default'

  return {
    components: { story },
    setup() {
      const themeClass = `theme-${theme}`
      return { themeClass }
    },
    template: `
      <div :class="themeClass" style="font-family: inherit;">
        <story />
      </div>
    `,
  }
}

export default withCustomTheme
