import type { Meta, StoryObj } from '@storybook/vue3-vite'
import type { ConcreteComponent } from 'vue'
import { expect } from 'storybook/test'
import DataTable from './DataTable.vue'
import dataTableArgTypes from './argTypes'
import type { DataTableColumn, DataTableProps } from './types'

/**
 * The component is generic (`Row`), which Storybook's Meta typing cannot
 * express — register it as an opaque component; every story provides its own
 * fully typed render function and args.
 */
const meta: Meta = {
  title: 'Components/Common/DataTable',
  component: DataTable as unknown as ConcreteComponent,
  argTypes: dataTableArgTypes,
  tags: ['autodocs'],
  // Column resize is on by default in every story so the divider handles
  // between the headers are visible; the dedicated story tests the drag.
  args: { resizable: true },
}

export default meta

type StateStory = StoryObj<{
  columns: DataTableColumn[]
  rows: StateRow[]
  title?: string
  emptyText?: string
}>

// --- Shared demo data -------------------------------------------------------

interface StateRow {
  code: string
  name: string
  available: boolean
}

interface SparseRow {
  code: string
  name: string
}

interface ResourceRow {
  code: string
  name: string
  owner: string
  position: string
  created: string
  updated: string
  tasks: number
  comments: number
  estimate: string
  priority: string
  phone: string
  email: string
}

const stateRows: StateRow[] = [
  { code: 'open', name: 'Открыт', available: true },
  { code: 'in_work', name: 'В работе: внутренняя обработка заявки, согласование с руководителем отдела и передача исполнителю', available: true },
  { code: 'on_hold', name: 'На удержании', available: false },
  { code: 'closed', name: 'Закрыт', available: false },
  { code: 'longword', name: 'Оченьдлинноеназваниебезпробеловдляпроверкипереноса' , available: true },
]

const stateColumns: DataTableColumn[] = [
  { key: 'code', label: 'Код', width: '140px' },
  { key: 'name', label: 'Название', width: 'fit-content(420px)' },
  { key: 'available', label: 'Доступность', width: '160px' },
]

// Wide table for the MMB pan story: 14 fixed 200px columns (~2800px) guarantee
// horizontal overflow of the scroll wrapper even in a wide browser window.
const panColumns: DataTableColumn[] = Array.from({ length: 14 }, (_, i) => ({
  key: `c${i}`,
  label: `Колонка ${i + 1}`,
  width: '200px',
}))
const panRows: Record<string, string>[] = Array.from({ length: 3 }, (_, r) => {
  const row: Record<string, string> = { id: String(r + 1) }
  for (let c = 0; c < 14; c++) row[`c${c}`] = `Ячейка ${r + 1}.${c + 1}`
  return row
})

const stateTemplate = `
  <DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText" :resizable="args.resizable">
    <template #actions>
      <button type="button" class="dt-demo-add" @click="noop">Создать статус</button>
    </template>
    <template #cell="{ row, column }">
      <span v-if="column.key === 'code'" style="font-weight:700; color:var(--ui-accent);">{{ row.code }}</span>
      <span v-else-if="column.key === 'available'"
        :style="{ display:'inline-block', padding:'2px 10px', borderRadius:'10px', fontSize:'13px', fontWeight:600,
                  background: row.available ? 'var(--ui-success-soft)' : 'var(--ui-danger-soft)',
                  color: row.available ? 'var(--ui-success)' : 'var(--ui-danger)' }">
        {{ row.available ? 'Доступен' : 'Недоступен' }}
      </span>
      <template v-else>{{ row[column.key] }}</template>
    </template>
  </DataTable>
`

const stateRender = (args: DataTableProps<StateRow>) => ({
  components: { DataTable },
  setup: () => ({ args, noop: () => {} }),
  template: stateTemplate,
})

// --- Stories ----------------------------------------------------------------

/** Статусы — базовый сценарий: 3 колонки, сортировка по любому заголовку. */
export const Statuses: StateStory = {
  name: 'Статусы (3 колонки)',
  args: { columns: stateColumns, rows: stateRows, title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: stateRender,
}

/**
 * Мало колонок: колонки прижаты к левому краю по содержимому, а шапка,
 * разделители и hover-подсветка строк идут на всю ширину карточки.
 */
export const SparseColumns: StoryObj<{
  columns: DataTableColumn[]
  rows: SparseRow[]
  title?: string
  emptyText?: string
}> = {
  name: 'Мало колонок для ширины',
  parameters: {
    docs: {
      description: {
        story:
          'Две короткие колонки на широком канвасе: данные слева, свободное место справа внутри карточки. Шапка и полосы строк растянуты вправо до края карточки.',
      },
    },
  },
  args: {
    columns: [
      { key: 'code', label: 'Код', width: '120px' },
      { key: 'name', label: 'Название', width: 'fit-content(280px)' },
    ],
    rows: [
      { code: 'a1', name: 'Альфа' },
      { code: 'b2', name: 'Бета-версия' },
      { code: 'g3', name: 'Гамма' },
      { code: 'd4', name: 'Дельта' },
    ],
    title: 'Справочник',
  },
  render: (args: DataTableProps<SparseRow>) => ({
    components: { DataTable },
    setup: () => ({ args }),
    template: `<DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText" :resizable="args.resizable" />`,
  }),
}

interface ResourceRow {
  code: string
  name: string
  owner: string
  position: string
  created: string
  updated: string
  tasks: number
  comments: number
  estimate: string
  priority: string
  phone: string
  email: string
}

type ResourceStory = StoryObj<{
  columns: DataTableColumn[]
  rows: ResourceRow[]
  title?: string
  emptyText?: string
}>

/**
 * Много колонок: карточка уже суммы колонок — появляется горизонтальный
 * скролл влево-вправо внутри карточки; колонки остаются прижатыми влево.
 */
export const ManyColumnsScroll: ResourceStory = {
  name: 'Много колонок — скролл',
  tags: ['vitest'],
  parameters: {
    docs: {
      description: {
        story:
          '12 колонок в карточке шириной 680px: суммарная ширина колонок больше карточки, поэтому внутри карточки работает горизонтальная прокрутка (заголовки и строки прокручиваются вместе).',
      },
    },
  },
  args: {
    columns: [
      { key: 'code', label: 'Код', width: '110px' },
      { key: 'name', label: 'Название', width: 'fit-content(180px)' },
      { key: 'owner', label: 'Владелец', width: 'fit-content(160px)' },
      { key: 'position', label: 'Должность', width: 'fit-content(180px)' },
      { key: 'created', label: 'Создан', width: '150px' },
      { key: 'updated', label: 'Обновлён', width: '150px' },
      { key: 'tasks', label: 'Задач', width: '90px' },
      { key: 'comments', label: 'Комментарии', width: '130px' },
      { key: 'estimate', label: 'Оценка', width: 'fit-content(120px)' },
      { key: 'priority', label: 'Приоритет', width: 'fit-content(140px)' },
      { key: 'phone', label: 'Телефон', width: '140px' },
      { key: 'email', label: 'E-mail', width: 'fit-content(200px)' },
    ],
    rows: [
      { code: 'R-01', name: 'Разработка печатной формы', owner: 'Иванов Иван', position: 'Разработчик', created: '12.01.2026', updated: '01.03.2026', tasks: 14, comments: 3, estimate: '2 нед', priority: 'Высокий', phone: '+7 912 111-22-33', email: 'ivanov@example.ru' },
      { code: 'R-02', name: 'Интеграция с 1С', owner: 'Петрова Анна', position: 'Аналитик', created: '15.01.2026', updated: '28.02.2026', tasks: 9, comments: 7, estimate: '3 нед', priority: 'Средний', phone: '+7 912 222-33-44', email: 'petrova@example.ru' },
      { code: 'R-03', name: 'Миграция серверов', owner: 'Сидоров Пётр', position: 'Администратор', created: '20.01.2026', updated: '10.02.2026', tasks: 2, comments: 0, estimate: '1 мес', priority: 'Низкий', phone: '+7 912 333-44-55', email: 'sidorov@example.ru' },
      { code: 'R-04', name: 'Отчёт по продажам', owner: 'Козлова Мария', position: 'Бизнес-аналитик', created: '02.02.2026', updated: '25.02.2026', tasks: 21, comments: 12, estimate: '2 мес', priority: 'Критичный', phone: '+7 912 444-55-66', email: 'kozlova@example.ru' },
      { code: 'R-05', name: 'Портал самообслуживания', owner: 'Смирнов Алексей', position: 'Frontend-разработчик', created: '05.02.2026', updated: '27.02.2026', tasks: 17, comments: 5, estimate: '1 мес', priority: 'Высокий', phone: '+7 912 555-66-77', email: 'smirnov@example.ru' },
    ],
    title: 'Ресурсы',
  },
  render: (args: DataTableProps<ResourceRow>) => ({
    components: { DataTable },
    setup: () => ({ args }),
    template: `
      <div style="max-width: 680px;">
        <DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText" :resizable="args.resizable" />
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    await step('many columns: the table area scrolls horizontally, the toolbar stays put', async () => {
      const scroll = canvasElement.querySelector<HTMLElement>('.dt-scroll')
      expect(scroll).toBeTruthy()
      expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.clientWidth)
      // columns stay packed left — the wrapper overflows, not the page
      expect(scroll!.scrollLeft).toBe(0)

      const tbar = canvasElement.querySelector<HTMLElement>('.dt-tbar')
      const tbarLeft = tbar!.getBoundingClientRect().left
      scroll!.scrollLeft = 300
      await new Promise((r) => setTimeout(r, 30))
      expect(scroll!.scrollLeft).toBe(300)
      // the toolbar must not travel with the columns
      expect(Math.abs(tbar!.getBoundingClientRect().left - tbarLeft)).toBeLessThan(1)
    })
  },
}

/** Сортировка: клик по заголовку меняет порядок строк (asc → desc → сброс). */
export const Sortable: StateStory = {
  name: 'Сортировка по заголовкам',
  tags: ['vitest'],
  args: { columns: stateColumns, rows: stateRows, title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: stateRender,
  play: async ({ canvasElement, step }) => {
    const headerButtons = () => [...canvasElement.querySelectorAll<HTMLButtonElement>('button.dt-th-label')]
    const firstCodes = () =>
      [...canvasElement.querySelectorAll<HTMLElement>('.dt-tr:not(.dt-th) .dt-cell:first-child')].map(
        (c) => c.textContent?.trim() ?? '',
      )

    const initial = firstCodes()
    expect(initial[0]).toBe('open')

    await step('click "Доступность": ascending — unavailable rows first', async () => {
      headerButtons()[2].click()
      await new Promise((r) => setTimeout(r, 30))
      const codes = firstCodes()
      expect(codes[0]).toBe('on_hold')
      expect(codes[1]).toBe('closed')
      expect(headerButtons()[2].getAttribute('aria-sort')).toBe('ascending')
    })

    await step('click again: descending — available rows first', async () => {
      headerButtons()[2].click()
      await new Promise((r) => setTimeout(r, 30))
      const codes = firstCodes()
      expect(codes[0]).toBe('open')
      expect(headerButtons()[2].getAttribute('aria-sort')).toBe('descending')
    })

    await step('click third time: sorting off, original order restored', async () => {
      headerButtons()[2].click()
      await new Promise((r) => setTimeout(r, 30))
      expect(firstCodes()).toEqual(initial)
      expect(headerButtons()[2].getAttribute('aria-sort')).toBe('none')
    })

    await step('click "Код": sorts codes ascending', async () => {
      headerButtons()[0].click()
      await new Promise((r) => setTimeout(r, 30))
      const codes = firstCodes()
      expect(codes[0]).toBe('closed')
      expect(codes[codes.length - 1]).toBe('open')
    })
  },
}

/** Пустая таблица: сообщение растягивается на всю ширину карточки. */
export const Empty: StateStory = {
  name: 'Пустая таблица',
  args: { columns: stateColumns, rows: [], title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: stateRender,
}

/** Ресайз колонок: перетаскивание края заголовка меняет ширину, двойной
 *  клик по краю возвращает автоширину. */
export const ResizableColumns: StoryObj<{
  columns: DataTableColumn[]
  rows: StateRow[]
  title?: string
  emptyText?: string
}> = {
  name: 'Изменение ширины колонок',
  tags: ['vitest'],
  args: { columns: stateColumns, rows: stateRows, title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: (args: DataTableProps<StateRow>) => ({
    components: { DataTable },
    data: () => ({ widths: {} as Record<string, number> }),
    setup: () => ({ args }),
    template: `
      <DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText"
        resizable v-model:column-widths="widths" />
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const firstHeader = () => canvasElement.querySelector<HTMLElement>('.dt-th-cell')
    const widthOf = () => firstHeader()!.getBoundingClientRect().width
    const fire = (type: string, x: number) =>
      document.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true }))

    await step('drag the header edge: the column width grows', async () => {
      const before = widthOf()
      const handle = firstHeader()!.querySelector<HTMLElement>('.dt-resizer')!
      handle.dispatchEvent(new MouseEvent('mousedown', { clientX: 100, bubbles: true }))
      fire('mousemove', 160)
      fire('mouseup', 160)
      await new Promise((r) => setTimeout(r, 50))
      const after = widthOf()
      expect(after).toBeGreaterThan(before + 30)
      const grid = canvasElement.querySelector<HTMLElement>('.dt-table')!.style.gridTemplateColumns
      expect(grid.split(' ')[0]).toMatch(/^\d+px$/) // first track got a fixed pixel width
      expect(grid).toContain('fit-content(420px)') // other tracks stay content-sized
    })

    await step('the divider line is visible and the last header has no handle', async () => {
      const firstHeader = () => canvasElement.querySelector<HTMLElement>('.dt-th-cell')
      const style = getComputedStyle(firstHeader()!.querySelector('.dt-resizer')!, '::before')
      expect(style.backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
      const headerCells = [...canvasElement.querySelectorAll<HTMLElement>('.dt-th > *')]
      const lastHandle = headerCells[headerCells.length - 1].querySelector<HTMLElement>('.dt-resizer')
      expect(lastHandle).not.toBeNull()
      expect(getComputedStyle(lastHandle!).display).toBe('none')
    })

    await step('double-click the handle: back to content-sized width', async () => {
      const handle = firstHeader()!.querySelector<HTMLElement>('.dt-resizer')!
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      await new Promise((r) => setTimeout(r, 50))
      const grid = canvasElement.querySelector<HTMLElement>('.dt-table')!.style.gridTemplateColumns
      expect(grid).toBe('140px fit-content(420px) 160px 1fr') // back to the configured tracks
    })
  },
}

/** Средняя кнопка мыши (СКМ): зажатие и перетаскивание двигает таблицу. */
export const MiddleButtonPan: StoryObj<{
  columns: DataTableColumn[]
  rows: Record<string, string>[]
}> = {
  name: 'Перемещение средней кнопкой мыши',
  tags: ['vitest'],
  args: { columns: panColumns, rows: panRows },
  render: (args: DataTableProps<Record<string, string>>) => ({
    components: { DataTable },
    setup: () => ({ args }),
    template: `
      <DataTable :columns="args.columns" :rows="args.rows" title="Широкая таблица" expandable>
        <template #expanded="{ row }">
          <div style="font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-2);">
            Детали строки {{ row.id }}.
          </div>
        </template>
      </DataTable>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const sc = () => canvasElement.querySelector<HTMLElement>('.dt-scroll')!
    const fire = (type: string, init: PointerEventInit) =>
      window.dispatchEvent(new PointerEvent(type, init))

    await step('MMB press + drag scrolls the table, LMB does not', async () => {
      // Dragging LEFT (content follows the pointer) scrolls the table rightward
      // — scrollLeft grows from the edge.
      sc().dispatchEvent(
        new PointerEvent('pointerdown', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 400, clientY: 80, bubbles: true }),
      )
      fire('pointermove', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 340, clientY: 80 })
      expect(sc().classList.contains('dt-panning')).toBe(true)
      expect(sc().scrollLeft).toBeGreaterThan(0)
      // global grabbing cursor while MMB is held
      expect(document.body.classList.contains('pan-grabbing')).toBe(true)
      fire('pointerup', { button: 1, buttons: 0, pointerType: 'mouse', clientX: 340, clientY: 80 })
      expect(sc().classList.contains('dt-panning')).toBe(false)
      expect(document.body.classList.contains('pan-grabbing')).toBe(false)

      // LMB drag must not pan — it keeps its own interactions (sort/expand)
      const before = sc().scrollLeft
      sc().dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 400, clientY: 120, bubbles: true }),
      )
      fire('pointermove', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 340, clientY: 120 })
      fire('pointerup', { button: 0, buttons: 0, pointerType: 'mouse', clientX: 340, clientY: 120 })
      expect(sc().classList.contains('dt-panning')).toBe(false)
      expect(sc().scrollLeft).toBe(before)
    })

    await step('a click that follows an MMB drag does not expand the row; a normal click does', async () => {
      const firstRow = () => canvasElement.querySelector<HTMLElement>('.dt-tr:not(.dt-th):not(.dt-detail)')!
      firstRow().dispatchEvent(
        new PointerEvent('pointerdown', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 400, clientY: 140, bubbles: true }),
      )
      fire('pointermove', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 340, clientY: 140 })
      fire('pointerup', { button: 1, buttons: 0, pointerType: 'mouse', clientX: 340, clientY: 140 })
      firstRow().dispatchEvent(new MouseEvent('click', { bubbles: true, button: 1 }))
      await new Promise((r) => setTimeout(r, 30))
      expect(canvasElement.querySelector('.dt-detail')).toBeNull()

      firstRow().click()
      await new Promise((r) => setTimeout(r, 30))
      expect(canvasElement.querySelector('.dt-detail')).toBeTruthy()
    })
  },
}

/** Раскрываемые строки: клик по строке показывает деталь под ней. */
export const Expandable: StoryObj<{
  columns: DataTableColumn[]
  rows: StateRow[]
  title?: string
  emptyText?: string
}> = {
  name: 'Раскрывающиеся строки',
  tags: ['vitest'],
  args: { columns: stateColumns, rows: stateRows, title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: (args: DataTableProps<StateRow>) => ({
    components: { DataTable },
    setup: () => ({ args }),
    template: `
      <DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText" expandable :resizable="args.resizable">
        <template #expanded="{ row }">
          <div style="font-size: calc(var(--ui-font-scale, 1) * 13px); color: var(--ui-text-2);">
            Детали статуса «{{ row.name }}»: код {{ row.code }}, доступность {{ row.available ? 'да' : 'нет' }}.
            Раскрытие переключается кликом по строке.
          </div>
        </template>
      </DataTable>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const detail = () => canvasElement.querySelector<HTMLElement>('.dt-detail')
    const firstRow = () => canvasElement.querySelector<HTMLElement>('.dt-tr:not(.dt-th):not(.dt-detail):not(.dt-filters)')

    await step('click on a row opens the detail row below it', async () => {
      expect(detail()).toBeNull()
      firstRow()!.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(detail()).toBeTruthy()
      expect(detail()!.textContent).toContain('Открыт')
      expect(firstRow()!.classList.contains('dt-tr--open')).toBe(true)
    })

    await step('click again closes the detail', async () => {
      firstRow()!.click()
      await new Promise((r) => setTimeout(r, 30))
      expect(detail()).toBeNull()
      expect(firstRow()!.classList.contains('dt-tr--open')).toBe(false)
    })
  },
}

/** Фильтр-строка: поля под заголовками, выровненные по колонкам. */
export const Filters: StoryObj<{
  columns: DataTableColumn[]
  rows: StateRow[]
  title?: string
  emptyText?: string
}> = {
  name: 'Фильтры в шапке',
  tags: ['vitest'],
  args: { columns: stateColumns, rows: stateRows, title: 'Статусы', emptyText: 'Нет данных о статусах' },
  render: (args: DataTableProps<StateRow>) => ({
    components: { DataTable },
    setup: () => ({ args }),
    template: `
      <DataTable :columns="args.columns" :rows="args.rows" :title="args.title" :empty-text="args.emptyText" :resizable="args.resizable">
        <template #filter="{ column }">
          <input v-if="column.key === 'code'" placeholder="по коду" style="box-sizing:border-box; width:100%; border:none; border-bottom:1px solid var(--ui-border-strong); border-radius:0; background:transparent; color:var(--ui-foreground); font:inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); padding:3px 0 4px;" />
          <input v-else-if="column.key === 'name'" placeholder="по названию" style="box-sizing:border-box; width:100%; border:none; border-bottom:1px solid var(--ui-border-strong); border-radius:0; background:transparent; color:var(--ui-foreground); font:inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); padding:3px 0 4px;" />
          <input v-else-if="column.key === 'available'" placeholder="по доступности" style="box-sizing:border-box; width:100%; border:none; border-bottom:1px solid var(--ui-border-strong); border-radius:0; background:transparent; color:var(--ui-foreground); font:inherit; font-size: calc(var(--ui-font-scale, 1) * 12px); padding:3px 0 4px;" />
        </template>
      </DataTable>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    await step('every filter sits inside its column header cell', async () => {
      const cells = [...canvasElement.querySelectorAll<HTMLElement>('.dt-th-cell')]
      expect(cells.length).toBe(3)
      const filled = cells.filter((c) => c.querySelector('input'))
      expect(filled.length).toBe(3)
      for (const cell of cells) {
        const input = cell.querySelector('input')
        if (!input) continue
        const il = input.getBoundingClientRect().left
        const ll = cell.querySelector('.dt-th-label')!.getBoundingClientRect().left
        expect(Math.abs(il - ll)).toBeLessThan(1)
      }
    })
  },
}