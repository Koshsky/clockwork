import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect } from 'storybook/test'
import TaskDependencyLinks from './TaskDependencyLinks.vue'
import taskDependencyLinksArgTypes from './argTypes'
import { makeDemoTimeline } from '@/components/planner/demoTimeline'
import { cellIndexForDate, cellStartDate, fmtDate } from '@/components/planner/calendar'
import { CELL_WIDTH } from '@/components/planner/layout'
import type { DependencyEdge, DependencyType } from '@/components/planner/dependencies'
import { LINK_STYLES, type LinkStyle } from '@/components/planner/linkStyle'

/**
 * The four dependency types live on ONE docs page: every story draws the same
 * connector — a line in the chosen shape, terminated by a tick on the
 * constrained date — over a mini-Gantt, so the anchors of fs/ss/ff/sf can be
 * compared side by side. `Styles` renders all six shapes over one scene.
 *
 * The origin is fixed (no "today" drift): the docs page must render the same
 * geometry on every run, which the play tests below rely on.
 */
const ORIGIN = '2026-01-05'
const UNIT = 'day' as const
const CELLS = 14
const SCENE_WIDTH = CELLS * CELL_WIDTH
/** Mirrors the component's bar inset, so the connectors meet the drawn bars. */
const BAR_INSET = 2

interface DemoTask {
  id: number
  title: string
  start_date: string
  end_date: string
}

interface Scene {
  tasks: DemoTask[]
  dependencies: DependencyEdge[]
}

/** A task occupying whole cells [start..end] of the demo day timeline. */
function task(id: number, title: string, start: number, end: number): DemoTask {
  return { id, title, start_date: fmtDate(cellStartDate(ORIGIN, UNIT, start)), end_date: fmtDate(cellStartDate(ORIGIN, UNIT, end)) }
}

const TYPE_TITLES: Record<DependencyType, string> = {
  fs: 'Окончание → Начало',
  ff: 'Окончание → Окончание',
  ss: 'Начало → Начало',
  sf: 'Начало → Окончание',
}

const TYPE_NOTES: Record<DependencyType, string> = {
  fs: 'кривая идёт от правого края предшественника к левому краю преемника; тик — на старте преемника',
  ff: 'от правого края к правому краю; тик — на окончании преемника',
  ss: 'от левого края к левому краю; тик — на старте преемника',
  sf: 'предшественник в нижней строке: кривая обходит преемника и входит в его правый край; тик — на окончании преемника',
}

/** One scene per type; the row order is the `tasks` order (row 0 — top). */
const SCENES: Record<DependencyType, Scene> = {
  fs: {
    tasks: [task(1, 'Подготовка', 1, 4), task(2, 'Монтаж', 7, 10)],
    dependencies: [{ id: 1, task_id: 2, depends_on_task_id: 1, type: 'fs' }],
  },
  ff: {
    tasks: [task(1, 'Закупка', 1, 5), task(2, 'Поставка', 3, 8)],
    dependencies: [{ id: 1, task_id: 2, depends_on_task_id: 1, type: 'ff' }],
  },
  ss: {
    tasks: [task(1, 'Проектирование', 3, 7), task(2, 'Согласование', 5, 9)],
    dependencies: [{ id: 1, task_id: 2, depends_on_task_id: 1, type: 'ss' }],
  },
  sf: {
    tasks: [task(1, 'Пусконаладка', 1, 5), task(2, 'Обучение', 4, 8)],
    dependencies: [{ id: 1, task_id: 1, depends_on_task_id: 2, type: 'sf' }],
  },
}

/** Mixed chain: fs → fs → ss on four rows (several curves on one scene). */
const CHAIN: Scene = {
  tasks: [
    task(1, 'Подготовка', 1, 3),
    task(2, 'Монтаж', 4, 6),
    task(3, 'Настройка', 7, 9),
    task(4, 'Обучение', 8, 11),
  ],
  dependencies: [
    { id: 1, task_id: 2, depends_on_task_id: 1, type: 'fs' },
    { id: 2, task_id: 3, depends_on_task_id: 2, type: 'fs' },
    { id: 3, task_id: 4, depends_on_task_id: 3, type: 'ss' },
  ],
}

/** Bar rectangle of a demo task (same cell math as the connector overlay). */
function barStyle(t: DemoTask): Record<string, string> {
  const startIdx = cellIndexForDate(ORIGIN, UNIT, t.start_date)
  const endIdx = cellIndexForDate(ORIGIN, UNIT, t.end_date)
  return {
    position: 'absolute',
    top: '1px',
    height: '24px',
    left: (startIdx * CELL_WIDTH + BAR_INSET) + 'px',
    width: ((endIdx - startIdx + 1) * CELL_WIDTH - 2 * BAR_INSET) + 'px',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    borderRadius: '5px',
    background: 'var(--ui-gantt-task)',
    color: 'var(--ui-accent-on)',
    fontSize: '11px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  }
}

/** One mini-Gantt: rows (26px) under a 20px strip, the overlay on top. */
const SCENE_TEMPLATE = `
  <div class="dl-scene" :style="{ position: 'relative', width: sceneWidth + 'px', paddingTop: '20px' }">
    <div v-for="t in tasks" :key="t.id" style="position:relative;height:26px;border-bottom:1px solid var(--ui-border)">
      <div :style="barStyle(t)">{{ t.title }}</div>
    </div>
    <TaskDependencyLinks :timeline="timeline" :tasks="tasks" :dependencies="dependencies" :connector="connector" />
  </div>
`

function sceneData(scene: Scene) {
  return {
    timeline: makeDemoTimeline(ORIGIN, UNIT, { viewportCells: CELLS }),
    tasks: scene.tasks,
    dependencies: scene.dependencies,
    sceneWidth: SCENE_WIDTH,
    // Explicit: the docs canvas must not depend on the reader's saved setting.
    connector: 'rounded' as LinkStyle,
  }
}

const meta: Meta<typeof TaskDependencyLinks> = {
  title: 'Components/Planner/TaskDependencyLinks',
  component: TaskDependencyLinks,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  argTypes: taskDependencyLinksArgTypes,
  args: {
    tasks: SCENES.fs.tasks,
    dependencies: SCENES.fs.dependencies,
    // Pinned so the docs canvas, screenshots and play tests stay deterministic:
    // the app itself follows the user's choice in Settings.
    connector: 'rounded',
  },
}
export default meta
type Story = StoryObj<typeof meta>

/** All four dependency types on one canvas — the docs page's main panel. */
export const AllTypes: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => ({
      timeline: makeDemoTimeline(ORIGIN, UNIT, { viewportCells: CELLS }),
      sceneWidth: SCENE_WIDTH,
      connector: 'rounded' as LinkStyle,
      panels: (['fs', 'ff', 'ss', 'sf'] as DependencyType[]).map((type) => ({
        type,
        title: TYPE_TITLES[type],
        note: TYPE_NOTES[type],
        ...SCENES[type],
      })),
    }),
    methods: { barStyle },
    template: `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:18px;">
        <section
          v-for="p in panels"
          :key="p.type"
          :data-type="p.type"
          style="border:1px solid var(--ui-border);border-radius:10px;padding:12px;background:var(--ui-surface);"
        >
          <div style="display:flex;align-items:baseline;gap:8px;margin-bottom:10px;">
            <code style="font-size:12px;font-weight:700;color:var(--ui-accent);">{{ p.type }}</code>
            <span style="font-size:13px;font-weight:600;color:var(--ui-text);">{{ p.title }}</span>
          </div>
          <div class="dl-scene" :style="{ position: 'relative', width: sceneWidth + 'px', paddingTop: '20px' }">
            <div v-for="t in p.tasks" :key="t.id" style="position:relative;height:26px;border-bottom:1px solid var(--ui-border)">
              <div :style="barStyle(t)">{{ t.title }}</div>
            </div>
            <TaskDependencyLinks :timeline="timeline" :tasks="p.tasks" :dependencies="p.dependencies" :connector="connector" />
          </div>
          <p style="margin:10px 0 0;font-size:11px;line-height:1.45;color:var(--ui-text-muted);">{{ p.note }}</p>
        </section>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    await step('all four types render on one canvas', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(canvasElement.querySelectorAll('[data-type]').length).toBe(4)
      expect(canvasElement.querySelectorAll('.tdl-path').length).toBe(4)
      expect(canvasElement.querySelectorAll('.tdl-tick').length).toBe(4)
    })

    await step('every connector is a finite path with a horizontal exit and entry', () => {
      for (const p of canvasElement.querySelectorAll<SVGPathElement>('.tdl-path')) {
        const d = p.getAttribute('d') ?? ''
        expect(d).toMatch(/^M -?\d+(?:\.\d+)?,-?\d+(?:\.\d+)? [LC] /)
        expect(d).not.toMatch(/NaN|undefined/)
      }
    })

    await step('terminus ticks stand perpendicular to the incoming curve', () => {
      for (const p of canvasElement.querySelectorAll<SVGPathElement>('.tdl-tick')) {
        const [x1, y1, x2, y2] = ((p.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
        expect(x1).toBe(x2)
        expect(y2).toBeGreaterThan(y1)
      }
    })
  },
}

/** fs: the curve leaves the predecessor's END and stops on the successor's START. */
export const Fs: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => sceneData(SCENES.fs),
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
  play: async ({ canvasElement, step }) => {
    await step('the tick lands on the successor start cell (+ bar inset)', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const tick = canvasElement.querySelector<SVGPathElement>('.tdl-tick')
      const tickX = Number((tick?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/)?.[0])
      const succStart = cellIndexForDate(ORIGIN, UNIT, SCENES.fs.tasks[1].start_date)
      expect(tickX).toBe(succStart * CELL_WIDTH + BAR_INSET)
    })

    await step('the curve starts on the predecessor end cell', () => {
      const path = canvasElement.querySelector<SVGPathElement>('.tdl-path')
      const startX = Number((path?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/)?.[0])
      const predEnd = cellIndexForDate(ORIGIN, UNIT, SCENES.fs.tasks[0].end_date)
      expect(startX).toBe((predEnd + 1) * CELL_WIDTH - BAR_INSET)
    })
  },
}

/** ff: both ends are the finish dates — the curve closes in from the right. */
export const Ff: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => sceneData(SCENES.ff),
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
  play: async ({ canvasElement, step }) => {
    await step('the tick lands on the successor end cell', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const tick = canvasElement.querySelector<SVGPathElement>('.tdl-tick')
      const tickX = Number((tick?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/)?.[0])
      const succEnd = cellIndexForDate(ORIGIN, UNIT, SCENES.ff.tasks[1].end_date)
      expect(tickX).toBe((succEnd + 1) * CELL_WIDTH - BAR_INSET)
    })
  },
}

/** ss: the anchor moves to the predecessor's start — the curve opens to the left. */
export const Ss: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => sceneData(SCENES.ss),
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
  play: async ({ canvasElement, step }) => {
    await step('the curve starts on the predecessor start cell', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const path = canvasElement.querySelector<SVGPathElement>('.tdl-path')
      const startX = Number((path?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/)?.[0])
      const predStart = cellIndexForDate(ORIGIN, UNIT, SCENES.ss.tasks[0].start_date)
      expect(startX).toBe(predStart * CELL_WIDTH + BAR_INSET)
    })
  },
}

/** sf: predecessor below, successor above — the curve wraps around the successor. */
export const Sf: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => sceneData(SCENES.sf),
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
  play: async ({ canvasElement, step }) => {
    await step('the connector rises from the lower row to the successor end', async () => {
      await new Promise((r) => setTimeout(r, 50))
      const path = canvasElement.querySelector<SVGPathElement>('.tdl-path')
      const nums = ((path?.getAttribute('d') ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
      // Loose coordinates: style-independent (either route ends on the bound edge).
      expect(nums[1]).toBeGreaterThan(nums[nums.length - 1])
      const succEnd = cellIndexForDate(ORIGIN, UNIT, SCENES.sf.tasks[0].end_date)
      expect(nums[nums.length - 2]).toBe((succEnd + 1) * CELL_WIDTH - BAR_INSET)
    })
  },
}

/** Several connectors on one scene: a chain of fs links plus an ss link. */
export const Chain: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => sceneData(CHAIN),
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
}

const STYLE_TITLES: Record<LinkStyle, string> = {
  sharp: 'Прямая',
  rounded: 'Закруглённая',
  smooth: 'Сглаженная',
  's-curve': 'Плавная кривая',
  hockey: 'Клюшка',
  metro: 'Под 45°',
}

/** Styles whose path is a polyline (with rounded or square corners). */
const POLYLINE_STYLES: LinkStyle[] = ['sharp', 'rounded', 'smooth', 'metro']
/** Styles whose path is a single cubic Bézier. */
const CURVE_STYLES: LinkStyle[] = ['s-curve', 'hockey']

/** All six shapes on one scene — the comparison gallery. */
export const Styles: Story = {
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => ({
      timeline: makeDemoTimeline(ORIGIN, UNIT, { viewportCells: CELLS }),
      sceneWidth: SCENE_WIDTH,
      panels: LINK_STYLES.map((style) => ({
        style,
        title: STYLE_TITLES[style],
        ...CHAIN,
      })),
    }),
    methods: { barStyle },
    template: `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(480px,1fr));gap:18px;">
        <section
          v-for="p in panels"
          :key="p.style"
          :data-style="p.style"
          style="border:1px solid var(--ui-border);border-radius:10px;padding:12px;background:var(--ui-surface);"
        >
          <div style="font-size:13px;font-weight:600;color:var(--ui-text);margin-bottom:10px;">{{ p.title }}</div>
          <div class="dl-scene" :style="{ position: 'relative', width: sceneWidth + 'px', paddingTop: '20px' }">
            <div v-for="t in p.tasks" :key="t.id" style="position:relative;height:26px;border-bottom:1px solid var(--ui-border)">
              <div :style="barStyle(t)">{{ t.title }}</div>
            </div>
            <TaskDependencyLinks :timeline="timeline" :tasks="p.tasks" :dependencies="p.dependencies" :connector="p.style" />
          </div>
        </section>
      </div>
    `,
  }),
  play: async ({ canvasElement, step }) => {
    const pathsIn = (style: LinkStyle) =>
      Array.from(canvasElement.querySelectorAll<SVGPathElement>(`[data-style="${style}"] .tdl-path`))
    const ticksIn = (style: LinkStyle) =>
      Array.from(canvasElement.querySelectorAll<SVGPathElement>(`[data-style="${style}"] .tdl-tick`)).map((p) =>
        p.getAttribute('d'),
      )

    await step('every style renders the same number of links', async () => {
      await new Promise((r) => setTimeout(r, 50))
      expect(canvasElement.querySelectorAll('[data-style]').length).toBe(LINK_STYLES.length)
      const expected = pathsIn(LINK_STYLES[0]).length
      expect(expected).toBeGreaterThan(0)
      for (const style of LINK_STYLES) expect(pathsIn(style).length, style).toBe(expected)
    })

    await step('polyline styles use line and corner commands only', () => {
      for (const style of POLYLINE_STYLES) {
        for (const p of pathsIn(style)) {
          const d = p.getAttribute('d') ?? ''
          expect(d, style).not.toContain('C')
          expect(d, style).toMatch(/^M /)
        }
      }
    })

    await step('curve styles are a single cubic Bézier', () => {
      for (const style of CURVE_STYLES) {
        for (const p of pathsIn(style)) {
          const d = p.getAttribute('d') ?? ''
          expect((d.match(/C/g) ?? []).length, style).toBe(1)
          expect(d, style).not.toContain('Q')
        }
      }
    })

    await step('the terminus tick does not depend on the style', () => {
      const reference = ticksIn(LINK_STYLES[0])
      for (const style of LINK_STYLES) expect(ticksIn(style), style).toEqual(reference)
    })
  },
}

/**
 * The app's own behaviour: this story passes no `connector`, so the links follow
 * the choice made in Settings → Diagrams (the style select there writes
 * `viewSettings.connector`).
 */
export const FromSettings: Story = {
  args: { connector: undefined },
  render: () => ({
    components: { TaskDependencyLinks },
    data: () => {
      const scene = sceneData(CHAIN)
      return { ...scene, connector: undefined }
    },
    methods: { barStyle },
    template: SCENE_TEMPLATE,
  }),
}
