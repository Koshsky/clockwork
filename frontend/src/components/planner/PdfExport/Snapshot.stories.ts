import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { expect, waitFor } from 'storybook/test'
import TaskPlanning from '../TaskPlanning/TaskPlanning.vue'
import { freezeDiagram, prepareSnapshot, snapshotCanvas, snapshotPdf } from './snapshot'
import type { SnapshotOptions } from './snapshot'
import { PDFDocument } from 'pdf-lib'

const dates = { start_date: '2026-10-01', end_date: '2027-02-28' }
const processes = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, project_id: i + 1, project_code: `P${i + 1}`,
  owner_id: i % 2 ? 7 : 8, title: `Process ${i + 1}`, ...dates,
  tasks: [{ id: i * 10 + 1, title: 'Visible badge and color', owner_id: 7, color: '#c55070', start_date: '2026-11-09', end_date: '2026-11-19',
    resources: [{ id: 1, code: 'ENG', assignment_id: i + 1, quantity: 1 }] }],
  milestones: [{ id: i + 1, date: '2026-11-12', title: 'Milestone' }],
}))
const groups = processes.map((process) => ({ id: process.id, title: process.title, rows: process.tasks }))
const options: SnapshotOptions = { groups, scope: 'tasks', showMilestones: true, showTodayLine: true,
  showResources: true, style: 'color', barThickness: 24 }
const meta: Meta<typeof TaskPlanning> = {
  title: 'Components/Planner/PdfSnapshot',
  component: TaskPlanning,
  parameters: { layout: 'fullscreen' },
  args: { processes, origin: '2026-11-01', focusDate: '2026-11-09', canManage: false,
    resources: [{ id: 1, code: 'ENG', employees_count: 4 }],
    calendar: [{ resource_id: 1, periods: [{ start_date: '2026-01-01', end_date: '2027-12-31', available: 4 }] }],
    users: [{ id: 7, last_name: 'Smith', first_name: 'John' }],
  },
  decorators: [() => ({ template: '<div style="width:1000px;--planner-max-height:340px"><story /></div>' })],
}
export default meta
type Story = StoryObj<typeof meta>

function scenario(unit: 'day' | 'week'): Story {
  return {
    args: { unit },
    play: async ({ canvasElement, step }) => {
      const source = canvasElement.querySelector<HTMLElement>('.tg-scroll')!
      await waitFor(() => expect(source.querySelectorAll('.gantt-bar').length).toBeGreaterThan(0))
      source.scrollTop = 220
      source.scrollLeft += 13
      source.dispatchEvent(new Event('scroll'))
      await new Promise((resolve) => setTimeout(resolve, 200))
      const before = { left: source.scrollLeft, top: source.scrollTop }
      const snapshot = freezeDiagram(source)
      try {
        await step('deep scroll freezes only visible detail while preserving the full layout', async () => {
          expect(snapshot.width).toBe(source.clientWidth)
          expect(snapshot.height).toBe(source.clientHeight)
          expect(snapshot.frame.querySelectorAll('.gantt-bar').length).toBeLessThan(10)
          expect(snapshot.frame.querySelectorAll('[data-pdf-placeholder]').length).toBeGreaterThan(80)
          const frame = snapshot.frame.getBoundingClientRect(), original = source.getBoundingClientRect()
          const header = source.querySelector('.tg-head')!.getBoundingClientRect()
          const clone = snapshot.frame.querySelector('.tg-head')!.getBoundingClientRect()
          expect(Math.abs((clone.top - frame.top) - (header.top - original.top))).toBeLessThan(0.1)
          const image = await snapshotCanvas(snapshot, options, 1)
          expect(image.width).toBe(snapshot.width)
          expect(image.height).toBe(snapshot.height)
          expect({ left: source.scrollLeft, top: source.scrollTop }).toEqual(before)
        })
        await step('display options affect the copy without changing the page', async () => {
          const filtered = prepareSnapshot(snapshot, { ...options, groups: groups.filter((g) => g.id % 2 === 0),
            showMilestones: false, showResources: false, showTodayLine: false, style: 'mono' })
          expect(filtered.querySelector('.ms, .rs-block, .rs-labels, .tl-line, .tl-band')).toBeNull()
          expect(filtered.style.filter).toBe('grayscale(1)')
          for (const group of filtered.querySelectorAll<HTMLElement>('.tg-task-group')) expect(Number(group.dataset.pdfGroup) % 2).toBe(0)
          expect(source.querySelectorAll('.rs-cell').length).toBeGreaterThan(0)
          expect(source.querySelectorAll('.ms').length).toBeGreaterThan(0)
          const empty = prepareSnapshot(snapshot, { ...options, groups: [] })
          expect(empty.querySelector('.tg-task-group')).toBeNull()
        })
        await step('bar thickness resizes rows and offscreen placeholders consistently', async () => {
          const resized = prepareSnapshot(snapshot, { ...options, barThickness: 40 })
          expect(resized.querySelector<HTMLElement>('.gantt-bar')!.style.height).toBe('40px')
          expect(resized.querySelector<HTMLElement>('.gg-row')!.style.height).toBe('42px')
          const placeholder = resized.querySelector<HTMLElement>('[data-pdf-placeholder]')!
          expect(parseFloat(placeholder.style.height)).toBe(146)
        })
        await step('selection includes offscreen groups and repeats the header across pages', async () => {
          const full = freezeDiagram(source, true)
          try {
            const far = await snapshotPdf(full, { ...options, extent: 'selection', groups: groups.filter((g) => g.id === 100) }, 'Offscreen selection')
            expect(far.pages.length).toBe(1)
            const farImage = new Image()
            farImage.src = far.pages[0].png
            await farImage.decode()
            const sidebar = document.createElement('canvas')
            sidebar.width = 300
            sidebar.height = 260
            const sidebarContext = sidebar.getContext('2d')!
            const headerHeight = source.querySelector('.tg-head')!.getBoundingClientRect().height + (source.querySelector('.rs-block')?.getBoundingClientRect().height ?? 0)
            sidebarContext.drawImage(farImage, 0, -headerHeight * 2)
            const pixels = sidebarContext.getImageData(0, 0, 300, 260).data
            let ink = 0
            for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200 && pixels[i + 1] < 200) ink++
            expect(ink).toBeGreaterThan(20)
            const selected = await snapshotPdf(full, { ...options, extent: 'selection', groups: groups.filter((g) => g.id <= 8) }, 'Multiple pages')
            expect(selected.pages.length).toBeGreaterThan(1)
            const pdf = await PDFDocument.load(selected.bytes)
            expect(pdf.getPageCount()).toBe(selected.pages.length)
            const headers: string[] = []
            for (const page of selected.pages) {
              const image = new Image()
              image.src = page.png
              await image.decode()
              const header = document.createElement('canvas')
              header.width = image.width
              header.height = Math.ceil((source.querySelector('.tg-head')!.getBoundingClientRect().height + (source.querySelector('.rs-block')?.getBoundingClientRect().height ?? 0)) * 2)
              header.getContext('2d')!.drawImage(image, 0, 0)
              headers.push(header.toDataURL())
            }
            expect(new Set(headers).size).toBe(1)
            expect({ left: source.scrollLeft, top: source.scrollTop }).toEqual(before)
          } finally { full.dispose() }
        })
        await step('the PDF uses the viewport size and remains frozen after page updates', async () => {
          const first = snapshot.frame.querySelector<HTMLElement>('.gantt-bar')!
          const color = first.style.backgroundColor
          for (const bar of source.querySelectorAll<HTMLElement>('.gantt-bar')) bar.style.backgroundColor = '#000'
          expect(first.style.backgroundColor).toBe(color)
          const bytes = await snapshotPdf(snapshot, options, 'Current view')
          const pdf = await PDFDocument.load(bytes.bytes)
          expect(pdf.getPageCount()).toBe(1)
          expect(pdf.getPage(0).getSize()).toEqual({ width: snapshot.width * 0.75, height: snapshot.height * 0.75 })
        })
      } finally {
        const host = snapshot.frame.parentElement!
        snapshot.dispose()
        expect(host.isConnected).toBe(false)
      }
    },
  }
}
export const Days = scenario('day')
export const Weeks = scenario('week')

const longProcess = {
  ...processes[0],
  tasks: Array.from({ length: 80 }, (_, i) => ({ ...processes[0].tasks[0], id: 1000 + i, title: `Long task ${i + 1}` })),
  dependencies: [{ id: 1, task_id: 1002, depends_on_task_id: 1000, type: 'fs' }],
}

export const LongProcessSidebar: Story = {
  args: { processes: [longProcess], unit: 'week' },
  play: async ({ canvasElement }) => {
    const source = canvasElement.querySelector<HTMLElement>('.tg-scroll')!
    await waitFor(() => expect(source.querySelectorAll('.gantt-bar').length).toBe(80))
    const full = freezeDiagram(source, true)
    try {
      expect(full.frame.querySelector<SVGElement>('.tdl-path')!.style.fill).toBe('none')
      const result = await snapshotPdf(full, { ...options, extent: 'selection', groups: [{ id: longProcess.id, title: longProcess.title, rows: longProcess.tasks }] }, 'Long process')
      expect(result.pages.length).toBeGreaterThan(2)
      const headerHeight = source.querySelector('.tg-head')!.getBoundingClientRect().height + source.querySelector('.rs-block')!.getBoundingClientRect().height
      for (const page of result.pages) {
        const image = new Image()
        image.src = page.png
        await image.decode()
        const sidebar = document.createElement('canvas')
        sidebar.width = 300
        sidebar.height = Math.floor((page.height - headerHeight) * 2)
        const context = sidebar.getContext('2d')!
        context.drawImage(image, 0, -headerHeight * 2)
        const pixels = context.getImageData(0, 0, sidebar.width, sidebar.height).data
        let ink = 0
        for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200 && pixels[i + 1] < 200) ink++
        expect(ink).toBeGreaterThan(20)
      }
    } finally { full.dispose() }
  },
}
