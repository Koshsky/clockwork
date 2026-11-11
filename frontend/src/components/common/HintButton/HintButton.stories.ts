import type { Meta, StoryObj } from '@storybook/vue3-vite'
import HintButton from './HintButton.vue'
import HintPanel from '../HintPanel/HintPanel.vue'
import { openHintPage } from '@/composables/useHints'

const meta: Meta<typeof HintButton> = {
  title: 'Components/Common/HintButton',
  component: HintButton,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    hint: 'scope-expressions',
  },
}
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: (args) => ({
    components: { HintButton, HintPanel },
    setup: () => ({ args }),
    template: `
      <div style="display:flex;align-items:center;gap:10px;font-family:sans-serif;">
        <span style="font-size: calc(var(--ui-font-scale, 1) * 13px);color:var(--muted-foreground);">Выражение области</span>
        <HintButton v-bind="args" />
        <HintPanel />
      </div>
    `,
    mounted() {
      // keep the panel closed; clicking the button opens it
    },
  }),
}

/** Pre-opened panel for visual inspection. */
export const WithPanel: Story = {
  render: () => ({
    components: { HintButton, HintPanel },
    template: `<HintButton hint="scope-expressions" /><HintPanel />`,
    mounted() {
      openHintPage('scope-expressions')
    },
  }),
}