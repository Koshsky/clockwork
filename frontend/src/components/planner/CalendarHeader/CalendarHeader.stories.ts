import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import CalendarHeader from './CalendarHeader.vue'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'
import { HEADER_HEIGHT_DAY, HEADER_HEIGHT_MONTH, LABEL_WIDTH } from '../layout'

const now = new Date()
const y = now.getFullYear()
const iso = (m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

const meta: Meta<typeof CalendarHeader> = {
  title: 'Components/Planner/CalendarHeader',
  component: CalendarHeader,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

function rangeStory(unit: 'day' | 'decade', startDay = 1): Story['render'] {
  return () => ({
    components: { CalendarHeader },
    data: () => ({ t: makeDemoTimeline(iso(1, startDay), unit, { windowStart: 0, viewportCells: 60 }) }),
    template: `
      <div style="width:3000px;position:relative;overflow:hidden;">
        <CalendarHeader :t="t" />
      </div>
    `,
  })
}

export const QuarterDays: Story = { render: rangeStory('day') }
export const QuarterDecades: Story = { render: rangeStory('decade') }
export const MidYearAnchor: Story = { render: rangeStory('day', 15) }

/**
 * Timeline whose window's first cell sits flush with the label column — the state
 * the planner opens in after scrolling to today (the scroll offset is a whole
 * number of cells). The corner cell overlaps that column edge, so a border on the
 * flush cell would put a second 1px line next to the corner's own one.
 */
function flushStory(unit: 'day' | 'decade', cellPx?: number): Story['render'] {
  return () => ({
    components: { CalendarHeader },
    data: () => {
      const t = makeDemoTimeline(iso(1, 1), unit, { cellPx, windowStart: 0, viewportCells: 24 })
      return { t: { ...t, cellLeft: (i: number) => LABEL_WIDTH + i * t.cellPx } }
    },
    template: `
      <div style="width:900px;height:200px;position:relative;overflow:hidden;">
        <CalendarHeader :t="t" />
      </div>
    `,
  })
}

/**
 * The corner cell and the calendar header must meet without a seam: the same 1px
 * line along their shared bottom row, and a single 1px line at their vertical
 * joint. The collapsed header states matter as much as the full one — there the
 * corner is the only element drawing the bottom edge.
 */
async function expectSeamlessJoint(canvasElement: HTMLElement, headerHeight: number) {
  const corner = canvasElement.querySelector('.th-corner') as HTMLElement
  const head = canvasElement.querySelector('.tg-head') as HTMLElement
  const cornerBox = corner.getBoundingClientRect()
  const cornerStyle = getComputedStyle(corner)

  expect(Math.round(cornerBox.width)).toBe(LABEL_WIDTH)
  expect(Math.round(cornerBox.height)).toBe(headerHeight)
  expect(Math.round(head.getBoundingClientRect().height)).toBe(headerHeight)
  // Same bottom row — no 1px step where the corner ends and the header begins
  expect(Math.round(cornerBox.bottom)).toBe(Math.round(head.getBoundingClientRect().bottom))

  // The header's bottom edge repeats the corner's bottom border: same 1px line, same colour
  expect(cornerStyle.borderBottomWidth).toBe('1px')
  const edge = getComputedStyle(head, '::after')
  expect(edge.content).not.toBe('none')
  expect(edge.height).toBe('1px')
  expect(edge.bottom).toBe('0px')
  expect(edge.backgroundColor).toBe(cornerStyle.borderBottomColor)

  // Vertical joint: the corner's right border is the only line there
  expect(cornerStyle.borderRightWidth).toBe('1px')
  for (const selector of ['.th-num', '.th-wd']) {
    const cells = Array.from(canvasElement.querySelectorAll<HTMLElement>(selector))
    if (!cells.length) continue
    expect(Math.round(cells[0].getBoundingClientRect().left)).toBe(Math.round(cornerBox.right))
    expect(getComputedStyle(cells[0]).borderLeftWidth).toBe('0px')
    expect(getComputedStyle(cells[1]).borderLeftWidth).toBe('1px')
  }
}

export const CornerMeetsHeader: Story = {
  render: flushStory('day'),
  play: async ({ canvasElement }) => expectSeamlessJoint(canvasElement, HEADER_HEIGHT_DAY),
}

export const CornerMeetsCollapsedHeader: Story = {
  render: flushStory('day', 4),
  play: async ({ canvasElement }) => expectSeamlessJoint(canvasElement, HEADER_HEIGHT_MONTH),
}

export const IsoWeeksAcrossMonths: Story = {
  render: () => ({
    components: { CalendarHeader },
    data: () => ({ t: makeDemoTimeline('2026-07-27', 'week', { cellPx: 110, viewportCells: 6 }) }),
    template: '<div style="position:relative;width:660px;height:80px"><CalendarHeader :t="t" /></div>',
  }),
  play: async ({ canvasElement }) => {
    const numbers = Array.from(canvasElement.querySelectorAll('.th-num'), (cell) => cell.textContent?.trim())
    expect(numbers).toEqual(['31', '32', '33', '34', '35', '36'])
    const months = canvasElement.querySelectorAll<HTMLElement>('.th-month')
    expect(parseFloat(months[1].style.left)).toBeCloseTo(110 * 5 / 7)
    expect(canvasElement.querySelectorAll('.th-wd')).toHaveLength(6)
  },
}

export const IsoWeeksAcrossYears: Story = {
  render: () => ({
    components: { CalendarHeader },
    data: () => ({ t: makeDemoTimeline('2026-12-28', 'week', { cellPx: 110, viewportCells: 3 }) }),
    template: '<div style="position:relative;width:330px;height:80px"><CalendarHeader :t="t" /></div>',
  }),
  play: async ({ canvasElement }) => {
    const numbers = Array.from(canvasElement.querySelectorAll('.th-num'), (cell) => cell.textContent?.trim())
    expect(numbers).toEqual(['53', '1', '2'])
    const months = canvasElement.querySelectorAll<HTMLElement>('.th-month')
    expect(parseFloat(months[1].style.left)).toBeCloseTo(110 * 4 / 7)
  },
}
