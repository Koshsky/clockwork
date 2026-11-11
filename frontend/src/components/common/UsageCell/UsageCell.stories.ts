import type { Meta, StoryObj } from '@storybook/vue3-vite'
import UsageCell from './UsageCell.vue'

const meta: Meta<typeof UsageCell> = {
  title: 'Components/Planner/UsageCell',
  component: UsageCell,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

// All UsageCell states on a single page with captions
export const AllStates: Story = {
  render: () => ({
    components: { UsageCell },
    template: `
      <div style="font-family:sans-serif;">
        <div style="display:grid;grid-template-columns:repeat(4, 150px);gap:24px;align-items:start;">

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Normal 60%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">3 / 5 — загрузка ≤100%</div>
            <div style="width:110px;"><UsageCell :used="3" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Normal 100%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">5 / 5 — ровно норма</div>
            <div style="width:110px;"><UsageCell :used="5" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Warn 120%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">6 / 5 — перегруз 20%</div>
            <div style="width:110px;"><UsageCell :used="6" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Warn 160%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">8 / 5 — перегруз 60%</div>
            <div style="width:110px;"><UsageCell :used="8" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Critical 180%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">9 / 5 — критическая перегруз</div>
            <div style="width:110px;"><UsageCell :used="9" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Critical 200%</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">10 / 5 — срочно нанимать</div>
            <div style="width:110px;"><UsageCell :used="10" :available="5" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Weekend</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">выходной день</div>
            <div style="width:110px;"><UsageCell :used="0" :available="5" :is-weekend="true" /></div>
          </div>

          <div style="display:flex;flex-direction:column;gap:8px;align-items:center;">
            <div style="font-size: calc(var(--ui-font-scale, 1) * 13px);font-weight:600;color:#444;">Unknown</div>
            <div style="font-size: calc(var(--ui-font-scale, 1) * 11px);color:#999;">нет данных о доступности</div>
            <div style="width:110px;"><UsageCell :used="2" /></div>
          </div>

        </div>
      </div>
    `,
  }),
}

