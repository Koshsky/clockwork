import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import TaskComments from './TaskComments.vue'
import type { DtoCommentResponse, DtoUserInfo } from '@/api'

const users: DtoUserInfo[] = [
  { id: 1, name: 'Иванов Иван', last_name: 'Иванов', first_name: 'Иван', username: 'ivanov', preset: 'vp' },
  { id: 2, name: 'Петров Пётр', last_name: 'Петров', first_name: 'Пётр', username: 'petrov', preset: 'rp' },
  { id: 3, name: 'Сидоров Сидор', last_name: 'Сидоров', first_name: 'Сидор', username: 'sidorov', preset: 'worker' },
]

/** Thread: c1 ← c2 ← c3 (three levels), a separate root c4 and an "orphaned" c5 (parent 999 deleted) */
const thread: DtoCommentResponse[] = [
  { id: 1, task_id: 1, author_id: 1, content: 'Перенести сроки?', created_at: '2026-02-01T10:00:00Z' },
  { id: 2, task_id: 1, author_id: 2, parent_id: 1, content: 'Нет, сроки фиксированы.', created_at: '2026-02-01T11:30:00Z' },
  { id: 3, task_id: 1, author_id: 3, parent_id: 2, content: 'Тогда уточните состав работ.', created_at: '2026-02-01T12:05:00Z' },
  { id: 4, task_id: 1, author_id: 3, content: 'Отдельный вопрос — бюджет.', created_at: '2026-02-02T09:15:00Z' },
  { id: 5, task_id: 1, author_id: 2, parent_id: 999, content: 'Ответ на удалённый комментарий.', created_at: '2026-02-03T08:00:00Z' },
]

const meta: Meta<typeof TaskComments> = {
  title: 'Components/Planner/TaskComments',
  component: TaskComments,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  args: {
    open: true,
    taskId: 1,
    taskTitle: 'Монтаж конструкций',
    comments: thread,
    users,
    userId: 2,
    canManage: true,
  },
}
export default meta
type Story = StoryObj<typeof meta>

/** Full thread: nested replies, a separate root and an "orphaned" reply */
export const Thread: Story = {}

/** No comments — empty state */
export const Empty: Story = {
  args: {
    comments: [],
  },
}

/** Backend error is shown inside the dialog */
export const WithError: Story = {
  args: {
    error: 'Не удалось загрузить комментарии: сеть недоступна',
  },
}

/** Loading in progress — spinner state for the list, sending blocked */
export const Busy: Story = {
  args: {
    comments: [],
    busy: true,
  },
}

/** Offline: sending blocked with a message, the cached list is visible */
export const Offline: Story = {
  args: {
    disabledReason: 'Недоступно в офлайне',
    canManage: false,
  },
}

/** Without moderation: "Delete" only on own comments (userId=2) */
export const AuthorDeleteOnly: Story = {
  args: {
    userId: 2,
    canManage: false,
  },
}

/** Test: renders the thread with names, content and the "orphaned" reply marker */
export const RendersThread: Story = {
  tags: ['vitest'],
  play: async () => {
    await new Promise((r) => setTimeout(r, 50))
    const root = document.body
    expect(root.textContent).toContain('Иванов Иван')
    expect(root.textContent).toContain('Петров Пётр')
    expect(root.textContent).toContain('Перенести сроки?')
    expect(root.textContent).toContain('Тогда уточните состав работ.')
    expect(root.textContent).toContain('в ответ на удалённый комментарий')
    // Nested replies render with an indent (depth > 0)
    const items = [...document.querySelectorAll('.tc-item')]
    expect(items.length).toBeGreaterThanOrEqual(5)
    const depths = items.map((el) => (el as HTMLElement).style.marginLeft)
    expect(depths.some((d) => d === '0px')).toBe(true)
    expect(depths.some((d) => d === '28px')).toBe(true)
  },
}

/** Test: empty state and blocked sending while offline */
export const EmptyAndOffline: Story = {
  tags: ['vitest'],
  args: {
    comments: [],
    disabledReason: 'Недоступно в офлайне',
  },
  play: async () => {
    await new Promise((r) => setTimeout(r, 50))
    const root = document.body
    expect(root.textContent).toContain('Комментариев пока нет')
    expect(root.textContent).toContain('Недоступно в офлайне')
    const textareas = [...document.querySelectorAll<HTMLTextAreaElement>('.tc-input')]
    if (textareas.length) {
      expect(textareas.every((t) => t.disabled)).toBe(true)
    }
    const send = [...document.querySelectorAll<HTMLButtonElement>('.tc-send')]
    if (send.length) expect(send.every((b) => b.disabled)).toBe(true)
  },
}