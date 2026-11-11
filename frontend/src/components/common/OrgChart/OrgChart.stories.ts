import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, userEvent, within } from 'storybook/test'
import OrgChart from './OrgChart.vue'
import { argTypes } from './argTypes'
import type { DtoAdminUserResponse } from '@/api'

const employees: DtoAdminUserResponse[] = [
  { id: 1, name: 'Morgan Director', position: 'Director', preset: 'admin' },
  { id: 2, manager_id: 1, name: 'Alex Manager', position: 'Project manager' },
  { id: 3, manager_id: 2, name: 'Casey Manager', position: 'Production manager' },
  { id: 4, manager_id: 3, name: 'Jordan Engineer', position: 'Design engineer' },
  { id: 5, manager_id: 2, last_name: 'Smith', first_name: 'Sam', name: 'Smith Sam', position: 'Engineer' },
]
const meta: Meta<typeof OrgChart> = { title: 'Components/Common/OrgChart', component: OrgChart, argTypes, args: { employees, stateKey: '' }, parameters: { layout: 'padded' } }
export default meta
type Story = StoryObj<typeof meta>
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(2)
    await expect(canvas.queryByRole('button', { name: /Jordan Engineer/ })).not.toBeInTheDocument()
    await userEvent.click(await canvas.findByRole('button', { name: 'Smith Sam' }))
    await expect(canvas.getByRole('heading', { name: 'Smith Sam' })).toBeVisible()
    await expect(canvasElement.querySelectorAll('select')).toHaveLength(0)
    const expand = canvasElement.querySelector<HTMLButtonElement>('.oc-branch[aria-expanded=false]')!
    await userEvent.click(expand)
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(3)
    await expect(canvas.getByRole('button', { name: 'Jordan Engineer' })).toBeVisible()
    const collapse = canvasElement.querySelector<HTMLButtonElement>('.oc-branch[aria-expanded=true]')!
    await userEvent.click(collapse)
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(1)
  },
}
export const Empty: Story = { args: { employees: [] } }
export const InvalidRelationships: Story = { args: { employees: [...employees, { id: 6, manager_id: 999, name: 'Orphan Employee' }, { id: 7, manager_id: 8, name: 'Cycle A' }, { id: 8, manager_id: 7, name: 'Cycle B' }] } }
export const LargeCompany: Story = {
  args: { employees: Array.from({ length: 10000 }, (_, i) => ({ id: i + 1, manager_id: i ? 1 : undefined, name: `Employee${i + 1} Test`, position: 'Engineer' })) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('region', { name: /^(Схема|Chart)$/ })
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(1)
    await expect(canvasElement.querySelectorAll('.ot-person')).toHaveLength(2)
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('.ot-more')!)
    await expect(canvasElement.querySelectorAll('.ot-person')).toHaveLength(5)
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(1)
  },
}
export const TeamOfFifty: Story = {
  args: { employees: [employees[0]!, ...Array.from({ length: 50 }, (_, i) => ({ id: i + 100, manager_id: 1, last_name: `Surname${String(i).padStart(2, '0')}`, first_name: 'First', middle_name: i % 2 ? undefined : 'Middle', position: 'Engineer' }))] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('.ot-person')).toHaveLength(2)
    await expect(canvasElement.querySelector('.ot-person')?.textContent).toContain('Surname00 F.M.')
    await expect(canvasElement.querySelectorAll('.ot-person')[1]?.textContent).toContain('Surname01 F.')
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('.ot-more')!)
    const firstHeight = canvasElement.querySelector<HTMLElement>('.oc-node')!.getBoundingClientRect().height
    const next = canvasElement.querySelector<HTMLButtonElement>('.ot-pagination button:last-child')!
    for (let i = 0; i < 9; i++) await userEvent.click(next)
    await expect(canvasElement.querySelector('.ot-pagination')?.textContent).toMatch(/46–50 (из|of) 50/)
    await expect(canvasElement.querySelectorAll('.ot-person')).toHaveLength(5)
    await expect(next).toBeDisabled()
    await expect(canvasElement.querySelector<HTMLElement>('.oc-node')!.getBoundingClientRect().height).toBe(firstHeight)
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('.ot-collapse')!)
    await expect(canvasElement.querySelectorAll('.ot-person')).toHaveLength(2)
  },
}
export const WithoutManagers: Story = {
  args: { employees: [{ id: 1, last_name: 'Surname' }, { id: 2, first_name: 'First' }, { id: 3, name: 'OnlyLogin', username: 'onlylogin' }] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll('.oc-node')).toHaveLength(0)
    await expect(canvasElement.querySelectorAll('.oc-unassigned .ot-person')).toHaveLength(2)
    await expect(canvasElement.querySelector('.ot-person')?.textContent).not.toContain('..')
    await userEvent.click(canvasElement.querySelector<HTMLButtonElement>('.ot-more')!)
    await expect(canvasElement.querySelectorAll('.oc-unassigned .ot-person')).toHaveLength(3)
  },
}
export const LongNames: Story = {
  args: { employees: [
    { id: 1, last_name: 'VeryLongSurnameWithoutAnySpaces', first_name: 'Alexandria', middle_name: 'Maximilian', position: 'Senior engineering and production department manager' },
    { id: 2, manager_id: 1, last_name: 'AnotherVeryLongEmployeeSurnameWithoutSpaces', first_name: 'First', middle_name: 'Middle', position: 'Engineer' },
  ] },
  render: (args) => ({ components: { OrgChart }, setup: () => ({ args }), template: '<div style="--ui-font-scale:1.2"><OrgChart v-bind="args" /></div>' }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole('region', { name: /^(Схема|Chart)$/ })
    const header = canvasElement.querySelector<HTMLElement>('.oc-person')!
    const text = canvasElement.querySelector<HTMLElement>('.oc-person-text')!
    await expect(text.getBoundingClientRect().bottom).toBeLessThanOrEqual(header.getBoundingClientRect().bottom)
    const card = canvasElement.querySelector<HTMLElement>('.oc-node')!
    await expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1)
  },
}
