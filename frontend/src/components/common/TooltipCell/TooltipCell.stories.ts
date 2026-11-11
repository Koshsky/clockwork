import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TooltipCell from './TooltipCell.vue'

const meta: Meta<typeof TooltipCell> = {
  title: 'Components/Common/TooltipCell',
  component: TooltipCell,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const ShortText: Story = {
  render: () => ({
    components: { TooltipCell },
    template: `
      <div style="padding:48px;font-family:sans-serif;text-align:center;">
        <TooltipCell :text="'Короткая подсказка'">
          <span style="font-size: calc(var(--ui-font-scale, 1) * 14px);border-bottom:1px dashed #999;cursor:default;">Наведи курсор</span>
        </TooltipCell>
      </div>
    `,
  }),
}

export const LongText: Story = {
  render: () => ({
    components: { TooltipCell },
    template: `
      <div style="padding:48px;font-family:sans-serif;text-align:center;">
        <TooltipCell :text="'Длинное описание: инженер ПТО отвечает за разработку и согласование проекта производства работ.'" multiline>
          <span style="font-size: calc(var(--ui-font-scale, 1) * 14px);border-bottom:1px dashed #999;cursor:default;">Развёрнутое описание</span>
        </TooltipCell>
      </div>
    `,
  }),
}

export const EmbeddedInCell: Story = {
  render: () => ({
    components: { TooltipCell },
    template: `
      <div style="width:200px;padding:12px;font-family:sans-serif;border:1px solid #e8e8e8;border-radius:8px;">
        <TooltipCell :text="'Монтажник — 4 человека'">
          <span style="font-size: calc(var(--ui-font-scale, 1) * 14px);font-weight:700;letter-spacing:.5px;border-bottom:1px dashed #999;">МК</span>
        </TooltipCell>
      </div>
    `,
  }),
}
