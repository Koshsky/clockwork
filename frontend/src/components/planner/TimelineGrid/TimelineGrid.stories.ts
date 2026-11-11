import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { ref } from 'vue'
import { expect } from 'storybook/test'
import TimelineGrid from './TimelineGrid.vue'
import Bar from '../Bar/Bar.vue'
import CalendarHeader from '../CalendarHeader/CalendarHeader.vue'
import { cellRangeForSpan, type PlanningUnit } from '../calendar'
import { LABEL_WIDTH } from '../layout'

const meta: Meta<typeof TimelineGrid> = {
  title: 'Planner/TimelineGrid (Фаза 2)',
  component: TimelineGrid,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}
export default meta
type Story = StoryObj<typeof meta>

const origin = '2026-07-01'

const rows = [
  { id: 1, name: 'Задача А', start: '2026-07-03', end: '2026-07-18', color: '#1a73e8' },
  { id: 2, name: 'Задача Б (старт в июне)', start: '2026-06-20', end: '2026-07-25', color: '#34a853' },
  { id: 3, name: 'Задача В', start: '2026-08-01', end: '2026-08-20', color: '#e8710a' },
]

function monthLabel(d: Date): string {
  const m = d.toLocaleDateString('ru', { month: 'long' })
  return m.charAt(0).toUpperCase() + m.slice(1) + ' ' + d.getFullYear()
}

function monthGroups(indices: number[], start: (i: number) => Date): { key: string; label: string; from: number; to: number }[] {
  const out: { key: string; label: string; from: number; to: number }[] = []
  for (const i of indices) {
    const d = start(i)
    const key = d.getFullYear() + '-' + d.getMonth()
    const last = out[out.length - 1]
    if (last && last.key === key) last.to = i
    else out.push({ key, label: monthLabel(d), from: i, to: i })
  }
  return out
}

function baseTemplate(unit: PlanningUnit): string {
  return `
    <div style="font-family:sans-serif;max-width:1100px;">
      <p style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#555;margin:0 0 8px;">
        origin = 2026-07-01 у левого края. Листай шкалу ${unit === 'day' ? 'влево/вправо' : ''} — ячейки и сетка
        пересобираются, диапазон расширяется бесконечно. ${unit === 'day' ? 'Задача Б начинается в июне — левее якоря.' : ''}
      </p>
      <TimelineGrid :origin="origin" unit="${unit}">
        <template #default="{ t }">
          <div style="position:sticky;top:0;z-index:30;background:#f8f9fa;border-bottom:2px solid #1a73e8;height:56px;">
            <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#f8f9fa;z-index:3;display:inline-flex;align-items:center;padding:0 10px;font-weight:700;font-size: calc(var(--ui-font-scale, 1) * 12px);">Объект / процесс</div>
            <div v-for="m in monthGroups(t.visibleIndices, t.cellStart)" :key="'m'+m.from"
              :style="{ position:'absolute', top:2, left: t.cellLeft(m.from)+'px', width: (m.to-m.from+1)*t.cellPx+'px', height:18, fontSize:11, fontWeight:600, color:'#444', overflow:'hidden', whiteSpace:'nowrap', paddingLeft:4 }">
              {{ m.label }}
            </div>
            <div v-for="i in t.visibleIndices" :key="'d'+i"
              :style="{ position:'absolute', top:20, left: t.cellLeft(i)+'px', width: t.cellPx+'px', height:36, fontSize:10, color:'#666', display:'flex', alignItems:'flex-end', justifyContent:'center', paddingBottom:2, borderLeft:'1px solid #e6e6e6' }">
              {{ t.cellStart(i).getDate() }}
            </div>
          </div>

          <div v-for="row in rows" :key="row.id"
            style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;">
            <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#fff;z-index:10;display:flex;align-items:center;padding:0 10px;font-size: calc(var(--ui-font-scale, 1) * 12px);font-weight:600;">{{ row.name }}</div>
            <div v-if="span(t.unit, row)"
              :style="{ position:'absolute', left: t.cellLeft(span(t.unit,row).startCell)+'px', width: (span(t.unit,row).endCell-span(t.unit,row).startCell)*t.cellPx+'px', top:4, height:30, background: row.color, borderRadius:5, color:'#fff', display:'flex', alignItems:'center', padding:'0 8px', fontSize:11, fontWeight:600, whiteSpace:'nowrap', overflow:'hidden' }">
              {{ row.name }}
            </div>
          </div>
        </template>
      </TimelineGrid>
    </div>
  `
}

export const Days: Story = {
  render: () => ({
    components: { TimelineGrid },
    setup() {
      return {
        origin,
        rows,
        monthGroups,
        span: (unit: PlanningUnit, r: (typeof rows)[number]) =>
          cellRangeForSpan(origin, unit, r.start, r.end),
      }
    },
    template: baseTemplate('day'),
  }),
}

export const Decades: Story = {
  render: () => ({
    components: { TimelineGrid },
    setup() {
      return {
        origin,
        rows,
        monthGroups,
        span: (unit: PlanningUnit, r: (typeof rows)[number]) =>
          cellRangeForSpan(origin, unit, r.start, r.end),
      }
    },
    template: baseTemplate('decade'),
  }),
}

/** Drag + autoscroll: real Bars inside TimelineGrid.
 *  Drag a bar toward the edge — the timeline scrolls automatically (the range expands). */
export const DragAutoscroll: Story = {
  render: () => ({
    components: { TimelineGrid, Bar },
    setup() {
      const rows = ref([
        { id: 1, start: '2026-07-03', end: '2026-07-18', color: '#1a73e8' },
        { id: 2, start: '2026-06-20', end: '2026-07-25', color: '#34a853' },
        { id: 3, start: '2026-08-01', end: '2026-08-20', color: '#e8710a' },
      ])
      return {
        origin,
        rows,
        span: (unit: PlanningUnit, r: { start: string; end: string }) =>
          cellRangeForSpan(origin, unit, r.start, r.end),
      }
    },
    template: `
      <div style="font-family:sans-serif;max-width:1100px;">
        <p style="font-size: calc(var(--ui-font-scale, 1) * 12px);color:#555;margin:0 0 8px;">
          Перетащи бар к правому/левому краю — шкала автопрокрутится. Ресайз за ручки тоже работает.
        </p>
        <TimelineGrid :origin="origin" unit="day">
          <template #default="{ t }">
            <div style="position:sticky;top:0;z-index:30;background:#f8f9fa;border-bottom:2px solid #1a73e8;height:20px;">
              <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#f8f9fa;z-index:3;display:flex;align-items:center;padding:0 10px;font-weight:700;font-size: calc(var(--ui-font-scale, 1) * 12px);">Задачи</div>
            </div>
            <div v-for="row in rows" :key="row.id" style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;">
              <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#fff;z-index:10;display:flex;align-items:center;padding:0 10px;font-size: calc(var(--ui-font-scale, 1) * 12px);font-weight:600;">Задача {{ row.id }}</div>
              <div style="position:absolute;inset:0;">
                <Bar
                  :timeline="t"
                  :startDate="row.start"
                  :endDate="row.end"
                  :color="row.color"
                  draggable
                  @change="(d) => (row.start = d.start_date, row.end = d.end_date)"
                />
              </div>
            </div>
          </template>
        </TimelineGrid>
      </div>
    `,
  }),
}

/** Panning is bound to the middle mouse button and starts from ANY point of the
 *  table — including the Gantt bars themselves (content never blocks moving it). */
export const MiddleButtonPan: Story = {
  tags: ['vitest'],
  render: () => ({
    components: { TimelineGrid, Bar },
    setup() {
      const rows = ref([
        { id: 1, start: '2026-07-03', end: '2026-07-18', color: '#1a73e8' },
        { id: 2, start: '2026-06-20', end: '2026-07-25', color: '#34a853' },
        { id: 3, start: '2026-08-01', end: '2026-08-20', color: '#e8710a' },
      ])
      return {
        origin,
        rows,
        span: (unit: PlanningUnit, r: { start: string; end: string }) =>
          cellRangeForSpan(origin, unit, r.start, r.end),
      }
    },
    template: `
      <div style="font-family:sans-serif;max-width:1100px;">
        <TimelineGrid :origin="origin" unit="day">
          <template #default="{ t }">
            <div style="position:sticky;top:0;z-index:30;background:#f8f9fa;border-bottom:2px solid #1a73e8;height:20px;">
              <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#f8f9fa;z-index:3;display:flex;align-items:center;padding:0 10px;font-weight:700;font-size: calc(var(--ui-font-scale, 1) * 12px);">Задачи</div>
            </div>
            <div v-for="row in rows" :key="row.id" style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;">
              <div style="position:absolute;inset:0;">
                <Bar
                  :timeline="t"
                  :startDate="row.start"
                  :endDate="row.end"
                  :color="row.color"
                  draggable
                  @change="(d) => (row.start = d.start_date, row.end = d.end_date)"
                />
              </div>
            </div>
          </template>
        </TimelineGrid>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const sc = () => canvasElement.querySelector<HTMLElement>('.tg-scroll')!
    const bar = () => canvasElement.querySelector<HTMLElement>('.gantt-bar')!
    const fire = (type: string, init: PointerEventInit) =>
      window.dispatchEvent(new PointerEvent(type, init))

    await step('MMB drag starting ON a bar pans the table', async () => {
      bar().dispatchEvent(
        new PointerEvent('pointerdown', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 400, clientY: 60, bubbles: true }),
      )
      fire('pointermove', { button: 1, buttons: 4, pointerType: 'mouse', clientX: 340, clientY: 60 })
      expect(sc().classList.contains('tg-panning')).toBe(true)
      // global grabbing cursor while MMB is held
      expect(document.body.classList.contains('pan-grabbing')).toBe(true)
      fire('pointerup', { button: 1, buttons: 0, pointerType: 'mouse', clientX: 340, clientY: 60 })
      expect(sc().classList.contains('tg-panning')).toBe(false)
      expect(document.body.classList.contains('pan-grabbing')).toBe(false)
    })

    await step('LMB drag on a bar stays a bar drag — no panning', async () => {
      bar().dispatchEvent(
        new PointerEvent('pointerdown', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 400, clientY: 60, bubbles: true }),
      )
      fire('pointermove', { button: 0, buttons: 1, pointerType: 'mouse', clientX: 340, clientY: 60 })
      expect(sc().classList.contains('tg-panning')).toBe(false)
      fire('pointerup', { button: 0, buttons: 0, pointerType: 'mouse', clientX: 340, clientY: 60 })
    })
  },
}

/**
 * The side column of names is an OPAQUE band for the whole visible height.
 *
 * Rows paint their own labels only where rows exist; everywhere else the grid,
 * the today line, dependency links and group overlays that fall left of the
 * column edge used to show through the column (which read as a transparent
 * strip). The band sits above the content and below the sticky labels, spans the
 * visible height (measured px, see LayersFitTheVisibleHeightWhenZoomed) and never
 * intercepts pointer events, so panning and the context menu are unchanged.
 */
export const SideColumnIsOpaque: Story = {
  tags: ['vitest'],
  render: Days.render,
  play: async ({ canvasElement, step }) => {
    const band = () => canvasElement.querySelector<HTMLElement>('.tg-side-col')!

    /** The token as the browser computes it (tokens are hex, computed styles rgb()) */
    const resolveColor = (token: string): string => {
      const probe = document.createElement('div')
      probe.style.color = `var(${token})`
      document.body.appendChild(probe)
      const value = getComputedStyle(probe).color
      probe.remove()
      return value
    }

    const tokenValue = (token: string): number =>
      Number(getComputedStyle(document.documentElement).getPropertyValue(token).trim())

    await step('the band paints the column surface and its border', () => {
      const cs = getComputedStyle(band())
      expect(cs.backgroundColor).toBe(resolveColor('--ui-surface'))
      expect(cs.borderRightWidth).toBe('1px')
      expect(cs.borderRightColor).toBe(resolveColor('--ui-border'))
      expect(cs.width).toBe(`${LABEL_WIDTH}px`)
    })

    await step('it is sticky and closes the full visible height without moving the layout', () => {
      const cs = getComputedStyle(band())
      expect(cs.position).toBe('sticky')
      expect(cs.top).toBe('0px')
      expect(cs.left).toBe('0px')
      // Height comes from --tg-fit-height (visible height / zoom, see the zoom
      // guard below); the negative margin keeps its flow contribution at zero.
      const height = Number.parseFloat(cs.height)
      const margin = Number.parseFloat(cs.marginBottom)
      expect(height).toBeGreaterThan(0)
      expect(margin).toBe(-height)
      expect(cs.height).toBe(getComputedStyle(band().parentElement!).getPropertyValue('--tg-fit-height').trim())
    })

    await step('it hides the content, not the labels, and never eats clicks', () => {
      const cs = getComputedStyle(band())
      expect(cs.zIndex).toBe('45')
      // above the today line and the content, below every sticky label layer
      expect(tokenValue('--z-side-backdrop')).toBeGreaterThan(tokenValue('--z-today'))
      expect(tokenValue('--z-side-row')).toBeGreaterThan(tokenValue('--z-side-backdrop'))
      expect(cs.pointerEvents).toBe('none')
    })
  },
}

const now = new Date()
const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`

/**
 * The layers that have to cover the visible height — the side column, the today
 * line and the grid lines — are sized in measured px, never in a percentage or a
 * viewport unit.
 *
 * Everything inside `.tg-content` is multiplied by the CSS zoom of the table
 * scale (Ctrl+wheel), and browsers disagree on whether relative units compensate
 * that factor: Firefox does not, so at 50% zoom `min-height: 100%` shrank the
 * content box, and with it the today line and the grid drawn from that box, to
 * half the visible height; `100dvh` did the same to the side column in every
 * engine. TimelineGrid therefore publishes `--tg-fit-height` = container
 * clientHeight / zoom, and this guard pins the behaviour at the zoom levels users
 * reach, failing if a relative unit comes back.
 */
export const LayersFitTheVisibleHeightWhenZoomed: Story = {
  tags: ['vitest'],
  render: () => ({
    components: { TimelineGrid },
    setup() {
      // Today has to be inside the window — the today line is what the bug cut in half
      return { origin: monthStart }
    },
    template: `
      <div style="height:640px;display:flex;flex-direction:column;font-family:sans-serif;">
        <TimelineGrid :origin="origin" unit="day" :style="{ flex: '1 1 auto', maxHeight: 'none' }">
          <template #default="{ t }">
            <div style="position:sticky;top:0;z-index:30;background:#f8f9fa;border-bottom:1px solid #e6e8ec;height:20px;">
              <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#f8f9fa;z-index:3;display:flex;align-items:center;padding:0 10px;font-weight:700;font-size: calc(var(--ui-font-scale, 1) * 12px);">Задачи</div>
            </div>
            <div v-for="n in 3" :key="n" style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;">
              <div style="position:sticky;left:0;width:${LABEL_WIDTH}px;height:100%;background:#fff;z-index:10;display:flex;align-items:center;padding:0 10px;font-size: calc(var(--ui-font-scale, 1) * 12px);font-weight:600;">Задача {{ n }}</div>
              <div :style="{ position:'absolute', left: t.cellLeft(n * 2) + 'px', width: t.cellPx * 4 + 'px', top:4, height:30, background:'#1a73e8', borderRadius:5 }"></div>
            </div>
          </template>
        </TimelineGrid>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const sc = () => canvasElement.querySelector<HTMLElement>('.tg-scroll')!
    const content = () => canvasElement.querySelector<HTMLElement>('.tg-content')!
    const band = () => canvasElement.querySelector<HTMLElement>('.tg-side-col')!
    const line = () => canvasElement.querySelector<HTMLElement>('.tl-line')
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))

    /** Ctrl+wheel through the real zoom path (useTimelineZoom.onWheel) */
    const zoomBy = async (ticks: number) => {
      const box = sc().getBoundingClientRect()
      for (let i = 0; i < Math.abs(ticks); i++) {
        sc().dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: ticks > 0 ? 120 : -120,
            deltaMode: 0,
            clientX: box.left + 200,
            clientY: box.top + 100,
            bubbles: true,
            cancelable: true,
          }),
        )
        await frame()
      }
      // the zoom applies its scroll compensation in nextTick — let it settle
      await new Promise((r) => setTimeout(r, 60))
      await frame()
    }

    const scale = () => Number.parseFloat(content().style.zoom || '1')

    /** Every layer covers the visible height, and the content box does not stretch it */
    const expectFullHeight = (label: string, withTodayLine: boolean) => {
      const h = sc().clientHeight
      const bandBox = band().getBoundingClientRect()
      expect(Math.round(bandBox.height), `${label}: side column height`).toBeGreaterThanOrEqual(h - 1)
      expect(Math.round(bandBox.height), `${label}: side column overshoot`).toBeLessThanOrEqual(h + 1)
      expect(Math.round(bandBox.top), `${label}: the column sticks to the top`).toBe(
        Math.round(sc().getBoundingClientRect().top),
      )
      const gridBox = canvasElement.querySelector<HTMLElement>('.tg-gridlines')!.getBoundingClientRect()
      expect(Math.round(gridBox.height), `${label}: grid lines height`).toBeGreaterThanOrEqual(h - 1)
      // the rows are shorter than the container: the content box must not add an empty scroll area
      const contentBox = content().getBoundingClientRect()
      expect(Math.round(contentBox.height), `${label}: content box height`).toBeLessThanOrEqual(h + 1)
      if (withTodayLine) {
        const lineEl = line()
        expect(lineEl, `${label}: today line is inside the window`).not.toBeNull()
        expect(Math.round(lineEl!.getBoundingClientRect().height), `${label}: today line height`)
          .toBeGreaterThanOrEqual(h - 1)
      }
    }

    await step('at 100% every layer covers the visible height', async () => {
      expectFullHeight('100%', true)
    })

    await step('zoomed out to ~50% they still do (Firefox used to cut them in half)', async () => {
      await zoomBy(-7)
      expect(scale(), 'zoomed out').toBeLessThan(0.6)
      expectFullHeight('50%', true)
    })

    await step('zoomed in the column keeps covering, without an empty scroll area', async () => {
      await zoomBy(12)
      expect(scale(), 'zoomed in').toBeGreaterThan(1.5)
      expectFullHeight('zoom in', false)
    })

    await step('scrolled to the bottom the column still covers the visible area', async () => {
      const el = sc()
      el.scrollTop = el.scrollHeight
      await frame()
      const box = el.getBoundingClientRect()
      const bandBox = band().getBoundingClientRect()
      expect(Math.round(bandBox.top), 'sticky at the bottom').toBe(Math.round(box.top))
      expect(Math.round(bandBox.bottom), 'covers the bottom edge').toBeGreaterThanOrEqual(Math.round(box.bottom) - 1)
    })
  },
}

/**
 * The date under the cursor must not depend on the scroll phase or on the zoom.
 *
 * The visible window is scrolled by an arbitrary fraction of a cell, so the first
 * rendered cell usually starts left of the label column edge. A conversion that
 * only looks at the pointer offset from the container edge and adds `windowStart`
 * therefore resolves a click near the LEFT edge of a cell to the previous one — a
 * project/process/task created from the context menu starts one column earlier
 * than the clicked one (the reported bug).
 *
 * Each click lands 2px inside the left edge of a fully visible cell; the emitted
 * date has to be that cell's own day in every phase.
 */
export const CtxMenuDateFollowsTheClickedCell: Story = {
  tags: ['vitest'],
  render: () => ({
    components: { TimelineGrid, CalendarHeader },
    setup() {
      /** Collects the dates the grid emits for context menu clicks */
      function onCtx(p: { date: string | null }) {
        const sink = document.querySelector<HTMLTextAreaElement>('.ctx-sink')
        if (sink) sink.value += `${p.date ?? 'null'}\n`
      }
      return { origin: monthStart, onCtx }
    },
    template: `
      <div style="font-family:sans-serif;">
        <TimelineGrid :origin="origin" unit="day" @ctxmenu="onCtx">
          <template #default="{ t }">
            <CalendarHeader :t="t" />
            <div v-for="n in 3" :key="n" style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;"></div>
          </template>
        </TimelineGrid>
        <textarea class="ctx-sink" style="display:none"></textarea>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const sc = () => canvasElement.querySelector<HTMLElement>('.tg-scroll')!
    const sink = () => document.querySelector<HTMLTextAreaElement>('.ctx-sink')!
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 90))
      await frame()
    }
    const dates = () => sink().value.trim().split('\n').filter(Boolean)

    /**
     * Click 2px inside the left edge of the first cell that is fully right of the
     * label column (the column is inside the zoomed content, so its rendered width
     * is LABEL_WIDTH * scale) and return the emitted date with the cell's day number.
     */
    const clickLeftEdgeOfVisibleCell = async (): Promise<{ date: string; day: number }> => {
      const box = sc().getBoundingClientRect()
      const column = canvasElement.querySelector<HTMLElement>('.tg-side-col')!.getBoundingClientRect()
      const cell = Array.from(canvasElement.querySelectorAll<HTMLElement>('.th-num')).find(
        (c) => c.getBoundingClientRect().left - box.left >= column.width + 2,
      )
      expect(cell, 'a fully visible day cell is rendered').toBeDefined()
      const cellBox = cell!.getBoundingClientRect()
      const clientX = cellBox.left + 2
      const clientY = box.top + Math.round(box.height / 2)
      const target = document.elementFromPoint(clientX, clientY) ?? sc()
      const before = dates().length
      target.dispatchEvent(
        new MouseEvent('contextmenu', { clientX, clientY, bubbles: true, cancelable: true }),
      )
      await settle()
      const list = dates()
      expect(list.length, 'the context menu event reached the grid').toBe(before + 1)
      return { date: list[list.length - 1], day: Number(cell!.textContent!.trim()) }
    }

    await step('aligned scroll: the date is the clicked cell', async () => {
      await settle()
      const { date, day } = await clickLeftEdgeOfVisibleCell()
      expect(new Date(date).getDate(), `emitted ${date}, clicked day ${day}`).toBe(day)
    })

    await step('off-grid scroll (click 2px inside a cell): still the clicked cell', async () => {
      sc().scrollLeft += 20 // 0.625 of a 32px cell — the phase that used to shift the date left
      await settle()
      // the step only tests something if the window really is off the cell grid
      expect(sc().scrollLeft % 32, 'the scroll phase is off-grid').not.toBe(0)
      const { date, day } = await clickLeftEdgeOfVisibleCell()
      expect(new Date(date).getDate(), `emitted ${date}, clicked day ${day}`).toBe(day)
    })

    await step('zoomed out: still the clicked cell', async () => {
      const el = sc()
      const box = el.getBoundingClientRect()
      for (let i = 0; i < 7; i++) {
        el.dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: -120,
            deltaMode: 0,
            clientX: box.left + 300,
            clientY: box.top + 100,
            bubbles: true,
            cancelable: true,
          }),
        )
        await frame()
      }
      await settle()
      const content = canvasElement.querySelector<HTMLElement>('.tg-content')!
      expect(Number.parseFloat(content.style.zoom || '1'), 'the grid is zoomed out').toBeLessThan(0.6)
      const { date, day } = await clickLeftEdgeOfVisibleCell()
      expect(new Date(date).getDate(), `emitted ${date}, clicked day ${day}`).toBe(day)
    })
  },
}

/**
 * The three planner diagrams (Projects / Processes / Tasks) share ONE view state:
 * the first visible date, the table zoom and the cell width — paging between the
 * tabs must not re-anchor the timeline.
 *
 * The position is stored as a date, not as a scroll offset in px: a px offset only
 * means something together with the range grown to the left (leftPad), and that
 * range is re-seeded on every mount. Restoring px therefore landed at a later date
 * on every switch — after panning ten days into the past, coming back from another
 * tab showed future dates only.
 */
export const ViewStateIsSharedAcrossTabs: Story = {
  tags: ['vitest'],
  render: () => ({
    components: { TimelineGrid, CalendarHeader },
    setup() {
      const tab = ref<'project' | 'process'>('project')
      /** "<id> <first visible date>" per emitted range — read back by the play function */
      function onRange(id: string, p: { from: string }) {
        const sink = document.querySelector<HTMLTextAreaElement>('.state-sink')
        if (sink) sink.value += `${id} ${p.from}\n`
      }
      return { tab, origin: monthStart, onRange }
    },
    template: `
      <div style="font-family:sans-serif;">
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <button class="tab-project" @click="tab = 'project'">Проекты</button>
          <button class="tab-process" @click="tab = 'process'">Процессы</button>
        </div>
        <TimelineGrid
          :key="tab"
          :id="tab"
          :origin="origin"
          unit="day"
          @visible-range="(p) => onRange(tab, p)"
        >
          <template #default="{ t }">
            <CalendarHeader :t="t" />
            <div v-for="n in 3" :key="n" style="position:relative;height:40px;border-bottom:1px solid #f0f0f0;"></div>
          </template>
        </TimelineGrid>
        <textarea class="state-sink" style="display:none"></textarea>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const sc = () => canvasElement.querySelector<HTMLElement>('.tg-scroll')!
    const content = () => canvasElement.querySelector<HTMLElement>('.tg-content')!
    const sink = () => document.querySelector<HTMLTextAreaElement>('.state-sink')!
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    /** The visible range is debounced by ~150ms in TimelineGrid */
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 300))
      await frame()
    }
    const rows = () =>
      sink().value.trim().split('\n').filter(Boolean).map((line) => {
        const [id, from] = line.split(' ')
        return { id, from }
      })
    const lastFrom = (id: string) => {
      const list = rows().filter((r) => r.id === id)
      return list.length ? list[list.length - 1]!.from : undefined
    }

    /** Middle-button pan of dx px; the view moves backwards when the mouse goes right */
    const panBy = async (dx: number) => {
      const el = sc()
      const box = el.getBoundingClientRect()
      const x0 = box.left + 600
      const y = box.top + 100
      el.dispatchEvent(new PointerEvent('pointerdown', {
        button: 1, buttons: 4, pointerType: 'mouse', bubbles: true, clientX: x0, clientY: y,
      }))
      for (const half of [0.5, 1]) {
        window.dispatchEvent(new PointerEvent('pointermove', {
          button: 1, buttons: 4, pointerType: 'mouse', clientX: x0 + dx * half, clientY: y,
        }))
        await frame()
      }
      window.dispatchEvent(new PointerEvent('pointerup', {
        button: 1, buttons: 0, pointerType: 'mouse', clientX: x0 + dx, clientY: y,
      }))
      await settle()
    }

    /** Ctrl+wheel — the table zoom; Ctrl+Shift+wheel — the cell width (column compression).
     *  Negative ticks zoom out / narrow the columns. */
    const wheelZoom = async (shift: boolean, ticks: number) => {
      const el = sc()
      const box = el.getBoundingClientRect()
      for (let i = 0; i < Math.abs(ticks); i++) {
        el.dispatchEvent(new WheelEvent('wheel', {
          ctrlKey: true,
          shiftKey: shift,
          deltaY: ticks > 0 ? 120 : -120,
          deltaMode: 0,
          clientX: box.left + 400,
          clientY: box.top + 100,
          bubbles: true,
          cancelable: true,
        }))
        await frame()
      }
      await settle()
    }

    /** Switch tabs by clicking the tab button (the grid is remounted with another id) */
    const switchTo = async (tab: 'project' | 'process') => {
      canvasElement.querySelector<HTMLButtonElement>(`.tab-${tab}`)!.click()
      await settle()
      await settle()
    }

    await step('panning into the past moves the first visible date back', async () => {
      await settle()
      const before = lastFrom('project')
      expect(before, 'the first visible range was emitted').toBeDefined()
      const widthBefore = content().getBoundingClientRect().width
      await panBy(260) // ~8 days at 32px, ending up before the origin so leftPad grows
      const after = lastFrom('project')
      expect(after, 'a range was emitted after panning').toBeDefined()
      expect(after! < before!, `${after} is not earlier than ${before}`).toBe(true)
      expect(content().getBoundingClientRect().width, 'the range grew to the left')
        .toBeGreaterThan(widthBefore)
    })

    await step('zoom and cell width are part of the state', async () => {
      await wheelZoom(false, 3)
      await wheelZoom(true, 3)
      expect(Number.parseFloat(content().style.zoom || '1'), 'zoomed in').toBeGreaterThan(1)
      expect(sc().style.getPropertyValue('--cell-width'), 'cell width set').not.toBe('')
    })

    await step('another tab opens at the same date, zoom and cell width', async () => {
      const from = lastFrom('project')
      const zoom = content().style.zoom
      const cellWidth = sc().style.getPropertyValue('--cell-width')
      expect(from, 'the position to remember').toBeDefined()

      await switchTo('process')
      expect(lastFrom('process'), 'the processes tab kept the visible date').toBe(from)
      expect(content().style.zoom, 'the processes tab kept the zoom').toBe(zoom)
      expect(sc().style.getPropertyValue('--cell-width'), 'the processes tab kept the cell width')
        .toBe(cellWidth)

      await switchTo('project')
      expect(lastFrom('project'), 'the projects tab kept the visible date').toBe(from)
      expect(content().style.zoom, 'the projects tab kept the zoom').toBe(zoom)
    })

    await step('repeated switches with narrow columns do not drift', async () => {
      // The reported setup: narrow columns, where a one-cell slip is a whole day
      await wheelZoom(true, -8)
      const cellWidth = Number.parseFloat(sc().style.getPropertyValue('--cell-width') || '32')
      expect(cellWidth, 'the columns are narrow').toBeLessThan(24)
      const from = lastFrom('project')
      expect(from, 'the position before the switches').toBeDefined()

      for (let round = 0; round < 3; round++) {
        await switchTo('process')
        expect(lastFrom('process'), `round ${round}: processes kept the date`).toBe(from)
        await switchTo('project')
        expect(lastFrom('project'), `round ${round}: projects kept the date`).toBe(from)
      }
    })
  },
}
