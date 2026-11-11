import { afterEach, expect, it, vi } from 'vitest'
import { createSSRApp, h } from 'vue'
import { renderToString } from '@vue/server-renderer'
vi.mock('@/components/common', async () => ({
  BarTooltip: { render: () => null },
  TooltipCell: (await import('@/components/common/TooltipCell/TooltipCell.vue')).default,
}))
import TaskBar from './TaskBar.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'
import { viewSettings } from '@/settings'

const task = {
  id: 1, title: 'Unfiltered task', start_date: '2026-01-04', end_date: '2026-01-09',
  owner_short: 'Owner O.', responsible_short: 'Responsible R.',
  resources: [
    { resource_id: 10, assignment_id: 1, quantity: 2, code: 'RESOURCE_A' },
    { resource_id: 20, assignment_id: 2, quantity: 3, code: 'RESOURCE_B' },
  ],
}
const previous = { ...viewSettings }
afterEach(() => { Object.assign(viewSettings, previous) })
async function render(ids?: ReadonlySet<number>) {
  return renderToString(createSSRApp({ render: () => h(TaskBar, {
    timeline: makeDemoTimeline('2026-01-01', 'day'), task, resourceBadgeIds: ids, projectCode: 'PROJECT',
  }) }))
}
it('filters resource badges while keeping the task and other badges visible', async () => {
  Object.assign(viewSettings, { badgeResource: true, badgeTaskProjectCode: true, badgeTaskOwner: true, badgeTaskResponsible: true })
  const html = await render(new Set([10]))
  expect(html).toContain('RESOURCE_A×2')
  expect(html).not.toContain('RESOURCE_B×3')
  expect(html).toContain('Unfiltered task')
  expect(html).toContain('PROJECT')
  expect(html).toContain('Owner O.')
  expect(html).toContain('Responsible R.')
  expect(task.resources.map(row => row.quantity)).toEqual([2, 3])
})
it('shows all badges when the owner filter is cleared', async () => {
  viewSettings.badgeResource = true
  expect(await render(new Set([20]))).toContain('RESOURCE_B×3')
  const html = await render()
  expect(html).toContain('RESOURCE_A×2')
  expect(html).toContain('RESOURCE_B×3')
})
it('keeps the bar and removes the resource strip for an empty selection', async () => {
  viewSettings.badgeResource = true
  const html = await render(new Set())
  expect(html).toContain('Unfiltered task')
  expect(html).not.toContain('class="tb-badges')
})
it('does not enable badges disabled in individual settings', async () => {
  viewSettings.badgeResource = false
  const html = await render(new Set([10]))
  expect(html).not.toContain('class="tb-badges')
})
