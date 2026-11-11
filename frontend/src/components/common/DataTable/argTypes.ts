import type { ArgTypes } from '@storybook/vue3-vite'
import type { DataTableProps } from './types'

export const dataTableArgTypes: ArgTypes<DataTableProps> = {
  columns: {
    name: 'Колонки',
    description: 'Конфиг колонок: { key, label, width?, sortable? }. width — CSS <track-size> (например "140px" или "fit-content(420px)")',
    control: 'object',
    table: { type: { summary: 'DataTableColumn[]' }, category: 'Content' },
  },
  rows: {
    name: 'Строки',
    description: 'Данные таблицы (массив объектов)',
    control: 'object',
    table: { type: { summary: 'T[]' }, category: 'Content' },
  },
  title: {
    name: 'Заголовок',
    description: 'Заголовок в панели действий (слева)',
    control: 'text',
    table: { type: { summary: 'string' }, category: 'Content' },
  },
  emptyText: {
    name: 'Текст пустого состояния',
    description: 'Сообщение при отсутствии строк',
    control: 'text',
    table: {
      type: { summary: 'string' },
      defaultValue: { summary: 'Нет данных' },
      category: 'Content',
    },
  },
  expandable: {
    name: 'Раскрываемые строки',
    description: 'Клик по строке раскрывает деталь (слот #expanded) под ней',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  defaultSort: {
    name: 'Начальная сортировка',
    description: 'Стартовое состояние сортировки: { key, dir } (dir: 1 — по возрастанию, -1 — по убыванию)',
    control: 'object',
    table: {
      type: { summary: '{ key: string; dir: 1 | -1 } | null' },
      defaultValue: { summary: 'null' },
      category: 'Behavior',
    },
  },
  sortValue: {
    name: 'Значение сортировки',
    description: 'Кастомное значение для сортировки ячейки: (row, key) => unknown (по умолчанию row[key])',
    control: 'object',
    table: {
      type: { summary: '(row, key) => unknown' },
      category: 'Behavior',
    },
  },
  resizable: {
    name: 'Изменение ширины колонок',
    description: 'Ресайз колонок перетаскиванием за правый край заголовка (двойной клик — сброс к автоширине); используйте v-model:column-widths для сохранения',
    control: 'boolean',
    table: {
      type: { summary: 'boolean' },
      defaultValue: { summary: 'false' },
      category: 'Behavior',
    },
  },
  columnWidths: {
    name: 'Ширины колонок',
    description: 'Зафиксированные пиксельные ширины по ключу колонки: { key: px } (v-model:column-widths)',
    control: 'object',
    table: {
      type: { summary: 'Record<string, number>' },
      defaultValue: { summary: '{}' },
      category: 'Content',
    },
  },
}

export default dataTableArgTypes