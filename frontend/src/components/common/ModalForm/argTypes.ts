import type { ArgTypes } from '@storybook/vue3-vite'
import type { ModalFormProps, ModalField, ModalFieldOption } from './types'

export const modalFieldOptionArgType: ArgTypes<ModalFieldOption> = {
  value: {
    name: 'Значение',
    control: 'text',
    table: { type: { summary: 'number | string' } },
  },
  label: {
    name: 'Подпись',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
}

export const modalFieldArgType: ArgTypes<ModalField> = {
  key: {
    name: 'Ключ',
    description: 'Имя поля в payload при сохранении',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
  label: {
    name: 'Подпись',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
  type: {
    name: 'Тип',
    control: { type: 'select', options: ['text', 'textarea', 'select', 'number', 'date'] },
    table: { type: { summary: "'text' | 'textarea' | 'select' | 'number' | 'date'" } },
  },
  value: {
    name: 'Начальное значение',
    control: 'text',
    table: { type: { summary: 'number | string' } },
  },
  options: {
    name: 'Варианты (select)',
    control: 'object',
    table: { type: { summary: 'ModalFieldOption[]' } },
  },
  required: {
    name: 'Обязательное',
    control: 'boolean',
    table: { type: { summary: 'boolean' } },
  },
  placeholder: {
    name: 'Плейсхолдер',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
}

export const modalFormArgTypes: ArgTypes<ModalFormProps> = {
  open: {
    name: 'Открыта',
    control: 'boolean',
    table: { type: { summary: 'boolean' } },
  },
  title: {
    name: 'Заголовок',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
  fields: {
    name: 'Поля формы',
    control: 'object',
    table: { type: { summary: 'ModalField[]' } },
  },
  submitLabel: {
    name: 'Текст кнопки',
    control: 'text',
    table: { type: { summary: 'string' } },
  },
  busy: {
    name: 'Идёт сохранение',
    control: 'boolean',
    table: { type: { summary: 'boolean' } },
  },
}

export default modalFormArgTypes
