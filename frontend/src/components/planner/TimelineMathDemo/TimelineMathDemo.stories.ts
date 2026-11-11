import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import {
  addMonthsISO,
  cellIndexForDate,
  cellStartDate,
  cellEndDate,
  windowCells,
  spanToDates,
  type PlanningUnit,
} from '../calendar'

const meta: Meta = {
  title: 'Planner/TimelineMath (Фаза 1)',
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj

const fmt = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`

const fmtRange = (a: Date, b: Date) => {
  const aM = `${a.getDate()}.${a.getMonth() + 1}`
  const bM = `${b.getDate()}.${b.getMonth() + 1}.${b.getFullYear()}`
  return `${aM}–${bM}`
}

/** Consistency check: each cell's range must contain exactly itself */
function consistency(origin: string, unit: PlanningUnit, from: number, count: number): boolean {
  const cells = windowCells(origin, unit, from, count)
  return cells.every((c) => {
    const s = cellIndexForDate(origin, unit, cellStartDate(origin, unit, c.index))
    const e = cellIndexForDate(origin, unit, cellEndDate(origin, unit, c.index))
    return s === c.index && e === c.index
  })
}

/** Month color for visual clarity of the decade calendar alignment */
function monthColor(d: Date): string {
  const palette = ['#e3f2fd', '#fff3e0', '#e8f5e9', '#fce4ec', '#ede7f6', '#e0f7fa']
  return palette[((d.getFullYear() * 12 + d.getMonth()) % 6 + 6) % 6]
}

export const DayCells: Story = {
  render: () => ({
    data: () => ({
      origin: '2026-07-15',
      cells: windowCells('2026-07-15', 'day', -8, 26),
      decadeCells: windowCells('2026-07-15', 'decade', -4, 10),
      decadeCellsFromMonthStart: windowCells('2026-07-01', 'decade', 0, 6),
      originIdx: cellIndexForDate('2026-07-15', 'day', '2026-07-15'),
      span: spanToDates('2026-07-15', 'day', 2, 6),
    }),
    methods: { fmt, fmtRange, monthColor, consistency },
    template: `
      <div style="font-family:sans-serif;max-width:1100px;">
        <h3 style="margin:0 0 6px;font-size: calc(var(--ui-font-scale, 1) * 15px);">День: origin = 2026-07-15, индексы -8..17</h3>
        <div style="display:flex;overflow-x:auto;gap:2px;padding-bottom:10px;margin-bottom:18px;">
          <div v-for="c in cells" :key="c.index"
            :style="{ minWidth: 56, textAlign: 'center', fontSize: 11, padding: '4px 2px', border: '1px solid #e0e0e0', borderRadius: 4,
                      background: c.index === originIdx ? '#1a73e8' : '#fafafa', color: c.index === originIdx ? '#fff' : '#333' }">
            <div style="font-weight:700;">{{ c.index }}</div>
            <div>{{ fmt(c.start) }}</div>
          </div>
        </div>
        <p style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#555;margin:0 0 20px;">
          Синяя ячейка — индекс 0 (origin). Отрицательные индексы — слева от якоря, положительные — справа.
          Проверка спана [2,6) → {{ span.start_date }} … {{ span.end_date }}
        </p>

        <h3 style="margin:0 0 6px;font-size: calc(var(--ui-font-scale, 1) * 15px);">Декада: origin = 2026-07-15, индексы -4..5</h3>
        <div style="display:flex;overflow-x:auto;gap:2px;margin-bottom:8px;">
          <div v-for="c in decadeCells" :key="c.index"
            :style="{ minWidth: 96, textAlign: 'center', fontSize: 11, padding: '4px 2px', border: '1px solid #e0e0e0', borderRadius: 4,
                      background: monthColor(c.start), color: '#333' }">
            <div style="font-weight:700;">#{{ c.index }}</div>
            <div>{{ fmtRange(c.start, c.end) }}</div>
          </div>
        </div>
        <p style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#555;margin:0 0 20px;">
          Декады выровнены по календарю (1-10/11-20/21-конец), фоном выделены месяцы.
          Первая декада месяца-якоря частичная: ячейка 0 начинается в день якоря (15.07) и идёт до конца своей
          календарной декады (11–20 → 15–20); дни 11–14 лежат в ячейке −1.
        </p>

        <h3 style="margin:0 0 6px;font-size: calc(var(--ui-font-scale, 1) * 15px);">Декада: origin = 2026-07-01 (первое число — как стартовая позиция)</h3>
        <div style="display:flex;overflow-x:auto;gap:2px;margin-bottom:8px;">
          <div v-for="c in decadeCellsFromMonthStart" :key="c.index"
            :style="{ minWidth: 96, textAlign: 'center', fontSize: 11, padding: '4px 2px', border: '1px solid #e0e0e0', borderRadius: 4,
                      background: monthColor(c.start), color: '#333' }">
            <div style="font-weight:700;">#{{ c.index }}</div>
            <div>{{ fmtRange(c.start, c.end) }}</div>
          </div>
        </div>
        <p style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#555;margin:0;">
          Согласованность (индекс ячейки === индексы её границ): день={{ consistency('2026-07-01','day',-100,200) ? 'OK' : 'FAIL' }},
          декада={{ consistency('2026-07-15','decade',-50,100) ? 'OK' : 'FAIL' }}
        </p>
      </div>
    `,
  }),
}

/**
 * Unit test (vitest via @storybook/addon-vitest): pure calendar math —
 * the decade cells around a mid-month anchor are internally consistent,
 * cell 0 starts at the anchor day, and addMonthsISO clamps month-ends.
 */
export const CalendarMath: Story = {
  tags: ['vitest'],
  render: () => ({ template: '<div />' }),
  play: async () => {
    const fmt = (d: Date) =>
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

    // Partial first decade of the anchor month: cell 0 starts at the anchor.
    expect(fmt(cellStartDate('2026-07-17', 'decade', 0))).toBe('2026-07-17')
    expect(fmt(cellEndDate('2026-07-17', 'decade', 0))).toBe('2026-07-20')
    // Days before the anchor stay in a negative cell of the same month.
    expect(cellIndexForDate('2026-07-17', 'decade', '2026-07-15')).toBe(-1)
    expect(cellIndexForDate('2026-07-17', 'decade', '2026-07-05')).toBe(-2)
    expect(fmt(cellStartDate('2026-07-17', 'decade', 1))).toBe('2026-07-21')
    // An anchor on a decade boundary leaves the month fully aligned.
    expect(fmt(cellStartDate('2026-07-11', 'decade', 0))).toBe('2026-07-11')

    // Consistency (each cell's range maps back to itself) across anchors.
    for (const day of [5, 11, 17, 25]) {
      const origin = `2026-07-${String(day).padStart(2, '0')}`
      expect(consistency(origin, 'decade', -50, 100)).toBe(true)
    }
    const cells = windowCells('2026-07-17', 'decade', -4, 8)
    for (const c of cells) {
      expect(cellIndexForDate('2026-07-17', 'decade', c.start)).toBe(c.index)
      expect(cellIndexForDate('2026-07-17', 'decade', c.end)).toBe(c.index)
    }

    // addMonthsISO clamps to the last day of the target month.
    expect(addMonthsISO('2026-05-31', 6)).toBe('2026-11-30')
    expect(addMonthsISO('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonthsISO('2024-01-31', 1)).toBe('2024-02-29')
    expect(addMonthsISO('2026-03-15', 3)).toBe('2026-06-15')
    expect(addMonthsISO('2026-07-31', 6)).toBe('2027-01-31')
  },
}
