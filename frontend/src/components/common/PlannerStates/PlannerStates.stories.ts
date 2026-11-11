import type { Meta, StoryObj } from '@storybook/vue3-vite'
import PlannerStates from './PlannerStates.vue'

const meta: Meta<typeof PlannerStates> = {
  title: 'Components/Common/PlannerStates',
  component: PlannerStates,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const Loading: Story = {
  args: { loading: true, error: null, hasData: false },
}

export const ErrorWithData: Story = {
  args: { loading: false, error: 'Не удалось загрузить данные', hasData: true },
  render: (args) => ({
    components: { PlannerStates },
    setup: () => ({ args }),
    template: `<PlannerStates v-bind="args"><div style="height:80px;background:#eee;border-radius:6px"></div></PlannerStates>`,
  }),
}

export const Empty: Story = {
  args: { loading: false, error: null, hasData: false },
}

export const EmptyCustomText: Story = {
  args: { loading: false, error: null, hasData: false, emptyText: 'Пока ничего нет' },
}
