import type { ArgTypes } from '@storybook/vue3-vite'
import type { TaskCommentsProps } from './types'

export const taskCommentsArgTypes: ArgTypes<TaskCommentsProps> = {
  open: {
    name: 'Открыто',
    description: 'Показывать модальное окно',
    control: 'boolean',
    table: { category: 'State' },
  },
  taskId: {
    name: 'ID задачи',
    description: 'Идентификатор задачи, к которой относятся комментарии',
    control: 'number',
    table: { category: 'Data' },
  },
  taskTitle: {
    name: 'Название задачи',
    description: 'Название задачи в заголовке окна',
    control: 'text',
    table: { category: 'Data' },
  },
  comments: {
    name: 'Комментарии',
    description: 'Плоский список комментариев задачи (дерево строится по parent_id)',
    control: 'object',
    table: { type: { summary: 'DtoCommentResponse[]' }, category: 'Data' },
  },
  users: {
    name: 'Пользователи',
    description: 'Справочник пользователей для имён авторов',
    control: 'object',
    table: { type: { summary: 'DtoUserInfo[]' }, category: 'Data' },
  },
  busy: {
    name: 'Запрос',
    description: 'Идёт запрос к API — кнопки действий заблокированы',
    control: 'boolean',
    table: { category: 'State' },
  },
  error: {
    name: 'Ошибка',
    description: 'Сообщение об ошибке внутри окна',
    control: 'text',
    table: { category: 'State' },
  },
  disabledReason: {
    name: 'Причина блокировки',
    description: 'Отправка недоступна (например, офлайн); null — доступна',
    control: 'text',
    table: { category: 'State' },
  },
  canManage: {
    name: 'Модерация',
    description: 'Право удалять чужие комментарии (admin/vp)',
    control: 'boolean',
    table: { category: 'Data' },
  },
  userId: {
    name: 'Текущий пользователь',
    description: 'Автор всегда может удалить свой комментарий',
    control: 'number',
    table: { category: 'Data' },
  },
}

export default taskCommentsArgTypes