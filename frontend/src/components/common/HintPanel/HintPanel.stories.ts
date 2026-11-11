import type { Meta, StoryObj } from '@storybook/vue3-vite'
import HintPanel from './HintPanel.vue'
import { openHintPage } from '@/composables/useHints'

const meta: Meta<typeof HintPanel> = {
  title: 'Components/Common/HintPanel',
  component: HintPanel,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

/**
 * Interactive story: demonstrates the global hint panel. Clicking the button
 * opens the "Выражения области видимости" page (the registry page bound to
 * the scope "?" button of the rights editor). Close via ✕, the dimmed area or
 * Escape.
 */
export const ScopeExpressions: Story = {
  render: () => ({
    components: { HintPanel },
    data: () => ({}),
    template: `
      <div style="padding:24px;font-family:sans-serif;">
        <p style="color:var(--muted-foreground);font-size: calc(var(--ui-font-scale, 1) * 13px);margin-bottom:12px;">
          Демо глобальной панели подсказок: открывает страницу «Выражения области видимости» из центрального реестра.
        </p>
        <button type="button" @click="openHint"
                style="padding:8px 16px;border-radius:8px;border:none;background:var(--primary);color:var(--primary-foreground);cursor:pointer;">
          Открыть подсказку
        </button>
        <HintPanel />
      </div>
    `,
    methods: {
      openHint() {
        openHintPage('scope-expressions')
      },
    },
  }),
}

/** Read-only: the same panel pre-opened for visual inspection. */
export const Opened: Story = {
  render: () => ({
    components: { HintPanel },
    template: `<HintPanel />`,
    mounted() {
      openHintPage('scope-expressions')
    },
  }),
}