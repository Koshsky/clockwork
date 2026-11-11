import type { ArgTypes } from '@storybook/vue3-vite'
import type { ResourceManagerModalProps } from './types'

export const resourceManagerModalArgTypes: ArgTypes<ResourceManagerModalProps> = {
  open: {
    name: 'Открыто',
    description: 'Показывать модальное окно',
    control: 'boolean',
    table: { category: 'State' },
  },
  taskId: {
    name: 'ID задачи',
    description: 'Идентификатор задачи, для которой управляем ресурсами',
    control: 'number',
    table: { category: 'Data' },
  },
  taskTitle: {
    name: 'Название задачи',
    description: 'Название задачи в заголовке окна',
    control: 'text',
    table: { category: 'Data' },
  },
  resources: {
    name: 'Доступные ресурсы',
    description: 'Справочник ресурсов; уже назначенные исключаются из выбора',
    control: 'object',
    table: { type: { summary: 'ResourceOption[]' }, category: 'Data' },
  },
  assigned: {
    name: 'Назначенные ресурсы',
    description: 'Ресурсы, уже закреплённые за задачей',
    control: 'object',
    table: { type: { summary: 'AssignedResource[]' }, category: 'Data' },
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
}

export default resourceManagerModalArgTypes
