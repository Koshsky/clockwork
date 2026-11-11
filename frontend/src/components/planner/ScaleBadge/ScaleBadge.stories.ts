import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ScaleBadge from './ScaleBadge.vue'

const meta: Meta<typeof ScaleBadge> = {
  title: 'Components/Planner/ScaleBadge',
  component: ScaleBadge,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => ({
    components: { ScaleBadge },
    data: () => ({ scale: 0.89, bump: 0 }),
    methods: {
      zoom() {
        this.scale = Math.min(2, Math.max(0.5, +(this.scale * 0.9).toFixed(2)))
        this.bump++
      },
    },
    template: `
      <div style="max-width:760px;margin:0 auto;font-family:sans-serif;">
        <button style="padding:8px 14px;border-radius:6px;border:1px solid #ccc;background:#fff;cursor:pointer;" @click="zoom">Зумить (Ctrl+колесо)</button>
        <div style="position:relative;height:120px;margin-top:8px;border:1px solid #e8e8e8;border-radius:6px;overflow:auto;">
          <ScaleBadge :scale="scale" :bump="bump" />
        </div>
        <div style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#666;margin-top:6px;">Бейдж появляется на каждом зуме и гаснет через 900 мс.</div>
      </div>
    `,
  }),
}
