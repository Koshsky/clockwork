import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { nextTick } from 'vue'
import { expect } from 'storybook/test'
import { viewSettings } from '@/settings'
import ProcessBar from './ProcessBar.vue'
import type { ProcessBarProps } from './types'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'

const now = new Date()
const y = now.getFullYear()
const day = (m: number, d: number) => new Date(y, m - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const meta: Meta<typeof ProcessBar> = {
  title: 'Components/Planner/ProcessBar',
  component: ProcessBar,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

function withProcess(props: Partial<ProcessBarProps>): Story['render'] {
  return () => ({
    components: { ProcessBar },
    data: () => ({ timeline: makeDemoTimeline(iso(day(1, 1)), 'day'), ...props }),
    template: `
      <div style="max-width:800px;margin:0 auto;font-family:sans-serif;overflow-x:auto;">
        <div style="position:relative;width:3000px;height:36px;background:#f0f0f0;border-radius:6px;">
          <ProcessBar
            :timeline="timeline"
            :startDate="startDate"
            :endDate="endDate"
            :title="title"
            :projectCode="projectCode"
            :ownerName="ownerName"
            :color="color"
            :opacity="opacity"
            :ownerName="ownerName"
            :responsibleName="responsibleName"
          />
        </div>
      </div>
    `,
  })
}

export const Default: Story = {
  render: withProcess({
    startDate: iso(day(1, 10)),
    endDate: iso(day(2, 20)),
    title: 'Инсталляция',
    projectCode: 'КО-001',
    ownerName: 'ВП-1',
  }),
}
export const FullMonth: Story = {
  render: withProcess({
    startDate: iso(day(1, 1)),
    endDate: iso(day(1, 31)),
    title: 'Производство',
    projectCode: 'КО-001',
  }),
}
export const WithBounds: Story = {
  render: withProcess({
    startDate: iso(day(1, 15)),
    endDate: iso(day(2, 10)),
    title: 'Инсталляция',
    projectCode: 'КО-002',
    groupStartDate: iso(day(1, 5)),
    groupEndDate: iso(day(2, 25)),
  }),
}

export const PeopleBadgesFollowSettings: Story = {
  render: withProcess({
    startDate: iso(day(1, 1)), endDate: iso(day(1, 25)),
    title: 'Badge demo', projectCode: 'BADGES-DEMO',
    ownerName: 'Owner Example', responsibleName: 'Responsible Example',
  }),
  play: async ({ canvasElement }) => {
    const before = { owner: viewSettings.badgeProcessOwner, responsible: viewSettings.badgeProcessResponsible }
    try {
      viewSettings.badgeProcessOwner = true
      viewSettings.badgeProcessResponsible = true
      await nextTick()
      expect(canvasElement.querySelector('.lb-owner')?.textContent).toBe('Owner E.')
      expect(canvasElement.querySelector('.lb-responsible')?.textContent).toBe('Responsible E.')
      viewSettings.badgeProcessOwner = false
      await nextTick()
      expect(canvasElement.querySelector('.lb-owner')).toBeNull()
      expect(canvasElement.querySelector('.lb-responsible')).toBeTruthy()
      viewSettings.badgeProcessResponsible = false
      await nextTick()
      expect(canvasElement.querySelector('.lb-responsible')).toBeNull()
      viewSettings.badgeProcessOwner = true
      viewSettings.badgeProcessResponsible = true
      await nextTick()
      expect(canvasElement.querySelector('.lb-owner')).toBeTruthy()
      expect(canvasElement.querySelector('.lb-responsible')).toBeTruthy()
    } finally {
      viewSettings.badgeProcessOwner = before.owner
      viewSettings.badgeProcessResponsible = before.responsible
    }
  },
}
