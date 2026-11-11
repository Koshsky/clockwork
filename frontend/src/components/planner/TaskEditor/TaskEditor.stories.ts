import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TaskEditor from './TaskEditor.vue'

const task = {
  id: 1,
  title: 'Монтаж конструкций',
  color: '#0f83c4',
  status: 'in_progress',
  owner_id: 5,
  process_id: 1,
}

const subtasks = [
  { id: 11, title: 'Подготовка площадки', status: 'done' },
  { id: 12, title: 'Установка опор', status: 'in_progress' },
  { id: 13, title: 'Крепление ригелей', status: 'not_started' },
]

const ownerOptions = [
  { value: 5, label: 'Иванов И.И.' },
  { value: 7, label: 'Петров П.П.' },
]

const dependencies = [
  { id: 91, task_id: 1, depends_on_task_id: 2, type: 'fs' as const, title: 'Пуско-наладка' },
  { id: 92, task_id: 1, depends_on_task_id: 3, type: 'ss' as const, title: 'Закупка материалов' },
]

const dependencyOptions = [
  { value: 4, label: 'Обучение персонала' },
  { value: 5, label: 'Сдача объекта' },
]

const meta: Meta<typeof TaskEditor> = {
  title: 'Components/Planner/TaskEditor',
  component: TaskEditor,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    open: true,
    task,
    subtasks,
    ownerOptions,
    dependencies,
    dependencyOptions,
    canManage: true,
    canCreateSubtask: true,
    canManageDependencies: true,
  },
}
export default meta
type Story = StoryObj<typeof meta>

/** Manageable task with subtasks — the editing form + todo list */
export const Manageable: Story = {}

/** Read-only viewer: fields and subtask actions are disabled */
export const ReadOnly: Story = {
  args: {
    canManage: false,
    canCreateSubtask: false,
    canManageDependencies: false,
  },
}

/** Empty subtask list — the "No subtasks" empty state */
export const NoSubtasks: Story = {
  args: {
    subtasks: [],
  },
}

/** No dependency links yet — the "Зависимостей нет" empty state */
export const NoDependencies: Story = {
  args: {
    dependencies: [],
  },
}

/** Backend error shown inside the window */
export const WithError: Story = {
  args: {
    error: 'Не удалось сохранить: родительская задача не найдена',
  },
}

/** Subtask creation is blocked (e.g. offline) with a reason */
export const BlockedSubtaskCreation: Story = {
  args: {
    disabledReason: 'Недоступно в офлайне',
  },
}