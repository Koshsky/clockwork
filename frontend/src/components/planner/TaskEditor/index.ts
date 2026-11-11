import type { ArgTypes } from '@storybook/vue3-vite'
import { t } from '@/i18n'
import type { TaskEditorProps } from './types'

/**
 * Storybook arg-type descriptions for the task editor (Controls panel labels).
 * Built per call (not a module-level object) so the labels are translated at
 * access time and follow the interface language.
 */
export function taskEditorArgTypes(): ArgTypes<TaskEditorProps> {
  return {
    open: {
      name: t('planner.taskEditor.argTypes.open.name'),
      description: t('planner.taskEditor.argTypes.open.description'),
      control: 'boolean',
      table: { category: 'State' },
    },
    task: {
      name: t('planner.taskEditor.argTypes.task.name'),
      description: t('planner.taskEditor.argTypes.task.description'),
      control: 'object',
      table: { type: { summary: 'TaskEditorTask | null' }, category: 'Data' },
    },
    subtasks: {
      name: t('planner.taskEditor.argTypes.subtasks.name'),
      description: t('planner.taskEditor.argTypes.subtasks.description'),
      control: 'object',
      table: { type: { summary: 'SubtaskItem[]' }, category: 'Data' },
    },
    ownerOptions: {
      name: t('planner.taskEditor.argTypes.ownerOptions.name'),
      description: t('planner.taskEditor.argTypes.ownerOptions.description'),
      control: 'object',
      table: { type: { summary: 'OwnerOption[]' }, category: 'Data' },
    },
    canManage: {
      name: t('planner.taskEditor.argTypes.canManage.name'),
      description: t('planner.taskEditor.argTypes.canManage.description'),
      control: 'boolean',
      table: { category: 'State' },
    },
    canCreateSubtask: {
      name: t('planner.taskEditor.argTypes.canCreateSubtask.name'),
      description: t('planner.taskEditor.argTypes.canCreateSubtask.description'),
      control: 'boolean',
      table: { category: 'State' },
    },
    busy: {
      name: t('planner.taskEditor.argTypes.busy.name'),
      description: t('planner.taskEditor.argTypes.busy.description'),
      control: 'boolean',
      table: { category: 'State' },
    },
    error: {
      name: t('planner.taskEditor.argTypes.error.name'),
      description: t('planner.taskEditor.argTypes.error.description'),
      control: 'text',
      table: { category: 'State' },
    },
    disabledReason: {
      name: t('planner.taskEditor.argTypes.disabledReason.name'),
      description: t('planner.taskEditor.argTypes.disabledReason.description'),
      control: 'text',
      table: { category: 'State' },
    },
  }
}

export default taskEditorArgTypes
export { default as TaskEditor } from './TaskEditor.vue'
export * from './types'