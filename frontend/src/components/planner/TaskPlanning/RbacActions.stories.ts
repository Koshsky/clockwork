import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { nextTick, ref } from 'vue'
import { expect, fn, waitFor } from 'storybook/test'
import TaskPlanning from './TaskPlanning.vue'
import ProcessPlanning from '../ProcessPlanning/ProcessPlanning.vue'
import TaskEditor from '../TaskEditor/TaskEditor.vue'
import ResourceManagerModal from '../ResourceManagerModal/ResourceManagerModal.vue'

const meta: Meta<typeof TaskPlanning> = {
  title: 'Components/Planner/RbacActions',
  component: TaskPlanning,
  parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof meta>
const dates = { start_date: '2026-11-09', end_date: '2026-11-20' }

async function reorder(root: HTMLElement, group: number) {
  const bar = root.querySelector<HTMLElement>(`.gg-group[data-group="${group}"] .gantt-bar`)!
  const rect = bar.getBoundingClientRect()
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2
  const pointer = (target: EventTarget, type: string, dy: number) => target.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0,
    buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y + dy,
  }))
  pointer(bar, 'pointerdown', 0)
  pointer(window, 'pointermove', 20)
  pointer(window, 'pointermove', 40)
  await nextTick()
  pointer(window, 'pointerup', 40)
  await nextTick()
}

const taskReorder = fn(), processReorder = fn()

export const TaskAndMilestoneRights: Story = {
  render: () => ({
    components: { TaskPlanning },
    setup() {
      const mode = ref('task')
      const processes = [1, 2].map((id) => ({ id, title: `Process ${id}`, ...dates,
        tasks: [{ id, title: `Task ${id}`, ...dates }, { id: id + 10, title: `Second task ${id}`, ...dates }],
        milestones: [{ id, title: `Milestone ${id}`, date: '2026-11-12' }],
      }))
      return { mode, processes, taskReorder }
    },
    template: `<div style="width:1200px;height:700px"><button data-action="milestone" @click="mode='milestone'">Milestones only</button><button data-action="revoke" @click="mode='none'">Revoke</button><TaskPlanning :processes="processes" origin="2026-11-09" focus-date="2026-11-09" :can-manage="(id) => mode==='task' && id===1" :can-manage-milestones="(id) => mode==='milestone' && id===2" :reorderable="(id) => mode==='task' && id===1" @reorder="taskReorder" /></div>`,
  }),
  play: async ({ canvasElement }) => {
    const bars = () => canvasElement.querySelectorAll('.gantt-bar')
    await waitFor(() => expect(bars().length).toBe(4))
    expect(bars()[0].querySelectorAll('.gb-handle').length).toBe(2)
    expect(bars()[1].querySelectorAll('.gb-handle').length).toBe(0)
    taskReorder.mockClear()
    await reorder(canvasElement, 2)
    expect(taskReorder).not.toHaveBeenCalled()
    await reorder(canvasElement, 1)
    expect(taskReorder).toHaveBeenCalledWith({ processId: 1, from: 0, to: 1 })
    expect(canvasElement.querySelectorAll('.ms-marker[role=slider]').length).toBe(0)
    canvasElement.querySelector<HTMLButtonElement>('[data-action="milestone"]')!.click()
    await waitFor(() => expect(canvasElement.querySelectorAll('.gb-handle').length).toBe(0))
    await waitFor(() => expect(canvasElement.querySelectorAll('.ms-marker[role=slider]').length).toBe(1))
    canvasElement.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.click()
    await waitFor(() => expect(canvasElement.querySelectorAll('.gb-handle, .ms-marker[role=slider]').length).toBe(0))
  },
}

export const ProcessRights: Story = {
  render: () => ({
    components: { ProcessPlanning },
    setup() {
      const granted = ref(true)
      const projects = [1, 2].map((id) => ({ id, code: `P${id}`, ...dates,
        processes: [{ id, title: `Process ${id}`, ...dates }, { id: id + 10, title: `Second process ${id}`, ...dates }],
      }))
      return { projects, granted, processReorder }
    },
    template: `<div style="width:1200px;height:700px"><button data-action="revoke" @click="granted=false">Revoke</button><ProcessPlanning :projects="projects" origin="2026-11-09" focus-date="2026-11-09" :can-manage="(id) => granted && id===1" :reorderable="(id) => granted && id===2" @reorder="processReorder" /></div>`,
  }),
  play: async ({ canvasElement }) => {
    await waitFor(() => expect(canvasElement.querySelectorAll('.gantt-bar').length).toBe(4))
    const bars = canvasElement.querySelectorAll('.gantt-bar')
    expect(bars[0].querySelectorAll('.gb-handle').length).toBe(2)
    expect(bars[1].querySelectorAll('.gb-handle').length).toBe(0)
    processReorder.mockClear()
    await reorder(canvasElement, 1)
    expect(processReorder).not.toHaveBeenCalled()
    await reorder(canvasElement, 2)
    expect(processReorder).toHaveBeenCalledWith({ projectId: 2, from: 0, to: 1 })
    canvasElement.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.click()
    await waitFor(() => expect(canvasElement.querySelectorAll('.gb-handle').length).toBe(0))
  },
}

export const SubtaskActions: Story = {
  render: () => ({
    components: { TaskEditor },
    setup() {
      const granted = ref(true)
      const update = fn(), remove = fn(), create = fn(), save = fn()
      return { granted, update, remove, create, save }
    },
    template: `<button data-action="revoke" @click="granted=false">Revoke</button><TaskEditor open :task="{id:1,title:'Read-only parent',process_id:1}" :subtasks="[{id:11,title:'Update only'},{id:12,title:'Delete only'}]" :owner-options="[]" :can-manage="false" :can-create-subtask="granted" :can-update-subtask="(id) => granted && id===11" :can-delete-subtask="(id) => granted && id===12" @save="save" @add-subtask="create" @update-subtask="update" @delete-subtask="remove" />`,
  }),
  play: async ({ canvasElement }) => {
    const root = canvasElement.ownerDocument.body
    await waitFor(() => expect(root.querySelectorAll('.te-item').length).toBe(2))
    const rows = root.querySelectorAll('.te-item')
    expect(rows[0].querySelector('.te-status')).not.toBeDisabled()
    expect(rows[0].querySelector('.te-remove')).toBeDisabled()
    expect(rows[1].querySelector('.te-status')).toBeDisabled()
    expect(rows[1].querySelector('.te-remove')).not.toBeDisabled()
    expect(root.querySelector('.te-save')).toBeDisabled()
    expect(root.querySelector('.te-add input')).not.toBeDisabled()
    canvasElement.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.click()
    await waitFor(() => expect(root.querySelector('.te-add input')).toBeDisabled())
    for (const button of root.querySelectorAll('.te-status, .te-remove')) expect(button).toBeDisabled()
  },
}

function assignments(action: 'create' | 'delete'): Story {
  return {
    render: () => ({
      components: { ResourceManagerModal },
      setup: () => ({ granted: ref(true), action }),
      template: `<button data-action="revoke" @click="granted=false">Revoke</button><ResourceManagerModal open :task-id="1" :resources="[{id:2,title:'Available'}]" :assigned="[{resource_id:1,quantity:1,title:'Assigned'}]" :can-create="granted && action==='create'" :can-delete="granted && action==='delete'" />`,
    }),
    play: async ({ canvasElement }) => {
      const root = canvasElement.ownerDocument.body
      await waitFor(() => expect(root.querySelectorAll('.rm-body').length).toBe(1))
      expect(root.querySelectorAll('.rm-add').length).toBe(action === 'create' ? 1 : 0)
      expect(root.querySelectorAll('.rm-remove').length).toBe(action === 'delete' ? 1 : 0)
      canvasElement.querySelector<HTMLButtonElement>('[data-action="revoke"]')!.click()
      await waitFor(() => expect(root.querySelectorAll('.rm-add, .rm-remove').length).toBe(0))
    },
  }
}
export const AssignmentCreateOnly = assignments('create')
export const AssignmentDeleteOnly = assignments('delete')
