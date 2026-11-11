import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { ref } from 'vue'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import TaskEditor from './TaskEditor.vue'
import TaskComments from '../TaskComments/TaskComments.vue'
import ResourceManagerModal from '../ResourceManagerModal/ResourceManagerModal.vue'
import type { TaskEditorPatch, TaskEditorSection } from './types'
import type { SendCommentPayload } from '../TaskComments/types'
import { t } from '@/i18n'

const meta: Meta<typeof TaskEditor> = {
  title: 'Components/Planner/TaskWorkspace',
  component: TaskEditor,
  parameters: { layout: 'fullscreen' },
  args: { workspace: true, open: true, task: { id: 1, process_id: 1, title: 'Task', status: 'in_progress', owner_id: 5 }, subtasks: [], ownerOptions: [] },
}
export default meta
type Story = StoryObj<typeof meta>

function workspace(options: { readonly?: boolean; failSave?: boolean; failComment?: boolean; section?: TaskEditorSection; delay?: number } = {}): Story['render'] {
  return (args) => ({
    components: { TaskEditor, TaskComments, ResourceManagerModal },
    setup() {
      const open = ref(true), section = ref<TaskEditorSection>(options.section ?? 'details')
      const relatedDraft = ref(false), granted = ref(!options.readonly)
      const task = ref({ id: 1, process_id: 1, title: 'Task', status: 'in_progress', owner_id: 5 })
      const comments = ref([{ id: 1, author_id: 5, content: 'Own comment' }, { id: 2, author_id: 9, content: 'Other comment' }])
      const assigned = ref([{ resource_id: 1, quantity: 1, title: 'Assigned' }])
      let saveAttempts = 0, commentAttempts = 0
      async function save(patch: TaskEditorPatch, acknowledge?: (saved: boolean) => void) {
        if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
        const saved = !(options.failSave && saveAttempts++ === 0)
        if (saved) task.value = { ...task.value, ...patch }
        acknowledge?.(saved)
      }
      function send(payload: SendCommentPayload, acknowledge?: (saved: boolean) => void) {
        const saved = !(options.failComment && commentAttempts++ === 0)
        if (saved) comments.value.push({ id: comments.value.length + 1, author_id: 5, content: payload.content })
        acknowledge?.(saved)
      }
      return { args, open, section, relatedDraft, granted, task, comments, assigned, save, send }
    },
    template: `<button data-action="revoke" @click="granted=false">Revoke</button>
      <button data-action="refresh" @click="task={...task,title:'Remote title'}">Refresh</button><TaskEditor v-if="open" v-bind="args" :task="task" v-model:section="section" context="Project / Process" schedule="09.11.2026 — 20.11.2026" :resource-count="assigned.length" :comment-count="comments.length" :has-related-drafts="relatedDraft" :can-manage="granted" :can-create-subtask="granted" :can-update-subtask="(id) => granted && id===11" :can-delete-subtask="(id) => granted && id===12" :can-manage-dependencies="granted" :owner-options="[{value:5,label:'Owner'}]" :subtasks="[{id:11,title:'Update only'},{id:12,title:'Delete only'}]" :dependencies="[{id:1,task_id:1,depends_on_task_id:2,type:'fs',title:'Predecessor'}]" :dependency-options="[{value:3,label:'Candidate'}]" @save="save" @close="open=false">
        <template #resources><ResourceManagerModal embedded open :task-id="1" :resources="[{id:1,title:'Assigned'},{id:2,title:'Available'}]" :assigned="assigned" can-create :can-delete="false" @add="assigned.push({...$event,title:'Available'})" /></template>
        <template #discussion><TaskComments embedded open :task-id="1" :comments="comments" :user-id="5" :can-manage="granted" @send="send" @draft-change="relatedDraft=$event" /></template>
      </TaskEditor>`,
  })
}
function root(canvas: HTMLElement) { return canvas.ownerDocument.body }
async function section(body: HTMLElement, name: string) {
  await userEvent.click(within(body.querySelector('.te-nav')!).getByRole('button', { name: new RegExp(`^${name}`) }))
}
function titleInput(body: HTMLElement) { return body.querySelector<HTMLInputElement>('.te-left input')! }

export const DraftsAcrossSections: Story = {
  render: workspace(),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement)
    await waitFor(() => expect(titleInput(body)).toHaveValue('Task'))
    expect(body.querySelectorAll('[role=dialog]')).toHaveLength(1)
    await userEvent.clear(titleInput(body))
    await userEvent.type(titleInput(body), 'Unsaved task')
    await section(body, t('planner.workspace.subtasks'))
    await userEvent.type(body.querySelector('.te-add input')!, 'New subtask draft')
    await section(body, t('planner.taskEditor.dependenciesTitle'))
    await userEvent.selectOptions(body.querySelector('.te-dep-add select')!, '3')
    await section(body, t('planner.workspace.resources'))
    await userEvent.selectOptions(body.querySelector('.rm-select')!, '2')
    await userEvent.clear(body.querySelector('.rm-qty')!)
    await userEvent.type(body.querySelector('.rm-qty')!, '4')
    await section(body, t('planner.workspace.discussion'))
    await userEvent.type(body.querySelector('.tc-composer textarea')!, 'Unsent comment')
    await section(body, t('planner.workspace.details'))
    canvasElement.querySelector<HTMLButtonElement>('[data-action=refresh]')!.click()
    await waitFor(() => expect(body.querySelector('.mf-title')).toHaveTextContent('Remote title'))
    expect(titleInput(body)).toHaveValue('Unsaved task')
    await section(body, t('planner.workspace.subtasks'))
    expect(body.querySelector('.te-add input')).toHaveValue('New subtask draft')
    await section(body, t('planner.taskEditor.dependenciesTitle'))
    expect(body.querySelector('.te-dep-add select')).toHaveValue('3')
    await section(body, t('planner.workspace.resources'))
    expect(body.querySelector('.rm-select')).toHaveValue('2')
    expect(body.querySelector('.rm-qty')).toHaveValue(4)
    await section(body, t('planner.workspace.discussion'))
    expect(body.querySelector('.tc-composer textarea')).toHaveValue('Unsent comment')
    expect(body.querySelectorAll('[role=dialog]')).toHaveLength(1)
  },
}

export const SaveFailureAndRetry: Story = {
  render: workspace({ failSave: true }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement)
    await userEvent.type(titleInput(body), ' changed')
    await userEvent.click(within(body).getByRole('button', { name: t('planner.workspace.saveTask') }))
    await waitFor(() => expect(body.querySelector('.te-footer [role=alert]')).toBeVisible())
    expect(titleInput(body)).toHaveValue('Task changed')
    await section(body, t('planner.workspace.resources'))
    await userEvent.click(within(body).getByRole('button', { name: t('planner.workspace.saveTask') }))
    await waitFor(() => expect(body.querySelector('.te-footer [role=alert]')).toBeNull())
    await userEvent.click(body.querySelector('.te-footer .te-cancel')!)
    await waitFor(() => expect(body.querySelector('[role=dialog]')).toBeNull())
  },
}

export const EscapeAndDiscard: Story = {
  render: workspace(),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement)
    await userEvent.type(titleInput(body), ' draft')
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.querySelector('.te-confirm')).toBeVisible())
    expect(body.querySelector('.te-confirm')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(body.querySelector('.te-confirm')).toBeNull())
    expect(titleInput(body)).toHaveValue('Task draft')
    await userEvent.click(body.querySelector('.mf-overlay')!)
    await userEvent.click(within(body).getByRole('button', { name: t('planner.workspace.discard') }))
    await waitFor(() => expect(body.querySelector('[role=dialog]')).toBeNull())
  },
}

export const SaveAndCloseWaitsForConfirmation: Story = {
  render: workspace({ delay: 500 }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement)
    await userEvent.type(titleInput(body), ' confirmed')
    await userEvent.click(body.querySelector('.mf-close')!)
    await userEvent.click(within(body).getByRole('button', { name: t('planner.workspace.saveAndClose') }))
    expect(body.querySelector('[role=dialog]')).toBeVisible()
    expect(within(body).getByRole('button', { name: t('planner.workspace.saveAndClose') })).toBeDisabled()
    expect(body.querySelector('.mf-close')).toBeDisabled()
    expect(body.querySelector('[role=dialog]')).toBeVisible()
    await waitFor(() => expect(body.querySelector('[role=dialog]')).toBeNull())
  },
}

export const IndependentPermissions: Story = {
  render: workspace({ readonly: true }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement)
    expect(titleInput(body)).toBeDisabled()
    expect(body.querySelector('.cf-trigger')).toBeDisabled()
    expect(body.querySelector('.te-footer .te-save')).toBeNull()
    await section(body, t('planner.workspace.resources'))
    expect(body.querySelector('.rm-select')).not.toBeDisabled()
    expect(body.querySelector('.rm-remove')).toBeNull()
    await section(body, t('planner.workspace.discussion'))
    expect(body.querySelector('.tc-composer textarea')).not.toBeDisabled()
    expect(body.querySelectorAll('.tc-del')).toHaveLength(1)
    await section(body, t('planner.taskEditor.dependenciesTitle'))
    expect(body.querySelector('.te-dep-add select')).toBeDisabled()
  },
}

export const SubtaskRightsAndRevocation: Story = {
  render: workspace({ section: 'subtasks' }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement), rows = body.querySelectorAll('.te-item')
    expect(rows[0].querySelector('.te-status')).not.toBeDisabled()
    expect(rows[0].querySelector('.te-remove')).toBeDisabled()
    expect(rows[1].querySelector('.te-status')).toBeDisabled()
    expect(rows[1].querySelector('.te-remove')).not.toBeDisabled()
    canvasElement.querySelector<HTMLButtonElement>('[data-action=revoke]')!.click()
    await waitFor(() => expect(body.querySelector('.te-add input')).toBeDisabled())
    for (const button of body.querySelectorAll('.te-status, .te-remove')) expect(button).toBeDisabled()
    await section(body, t('planner.workspace.details'))
    expect(body.querySelector('.cf-trigger')).toBeDisabled()
  },
}

export const CommentFailureKeepsDraft: Story = {
  render: workspace({ failComment: true, section: 'discussion' }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement), draft = body.querySelector<HTMLTextAreaElement>('.tc-composer textarea')!
    await userEvent.type(draft, 'Retry this comment')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(body.querySelector('.tc-error')).toBeVisible())
    expect(draft).toHaveValue('Retry this comment')
    await section(body, t('planner.workspace.resources'))
    await userEvent.click(body.querySelector('.mf-close')!)
    expect(body.querySelector('.te-confirm')).toBeVisible()
    expect(body.querySelector('.te-confirm .te-save')).toBeNull()
    await userEvent.click(within(body).getByRole('button', { name: t('planner.workspace.continueEditing') }))
    await section(body, t('planner.workspace.discussion'))
    expect(draft).toHaveValue('Retry this comment')
    await userEvent.click(body.querySelector('.tc-composer .tc-send')!)
    await waitFor(() => expect(draft).toHaveValue(''))
    expect(body.querySelectorAll('.tc-item')).toHaveLength(3)
    await userEvent.click(body.querySelector('.mf-close')!)
    await waitFor(() => expect(body.querySelector('[role=dialog]')).toBeNull())
  },
}

export const TabTrapSkipsHiddenSections: Story = {
  render: workspace({ section: 'resources' }),
  play: async ({ canvasElement }) => {
    const body = root(canvasElement), last = body.querySelector<HTMLButtonElement>('.te-footer .te-save')
    // A clean task has no enabled Save action, so Close is the final stop.
    expect(last).toBeDisabled()
    const close = body.querySelector<HTMLButtonElement>('.te-footer .te-cancel')!
    close.focus()
    await userEvent.keyboard('{Tab}')
    expect(body.querySelector('.mf-close')).toHaveFocus()
    await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
    expect(close).toHaveFocus()
  },
}
