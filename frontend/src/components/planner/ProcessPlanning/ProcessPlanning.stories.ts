import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ProcessPlanning from './ProcessPlanning.vue'
import type { DtoDetailedProject } from '@/api'

const now = new Date()
const y = now.getFullYear()
const day = (month: number, d: number) => new Date(y, month - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let projectSeq = 0

/**
 * Creates a project whose bounds are deliberately wider than those of its processes.
 * Processes sit at an offset from the project's edges.
 */
const project = (
  code: string,
  pStart: [number, number], pEnd: [number, number],
  p1: [number, number], p1End: [number, number],
  p2: [number, number], p2End: [number, number],
): DtoDetailedProject => {
  projectSeq += 1
  return {
    id: projectSeq,
    project_code: code,
    start_date: iso(day(pStart[0], pStart[1])),
    end_date: iso(day(pEnd[0], pEnd[1])),
    processes: [
      {
        id: projectSeq * 10 + 1, title: 'Производство',
        start_date: iso(day(p1[0], p1[1])), end_date: iso(day(p1End[0], p1End[1])),
      },
      {
        id: projectSeq * 10 + 2, title: 'Инсталляция',
        start_date: iso(day(p2[0], p2[1])), end_date: iso(day(p2End[0], p2End[1])),
      },
    ],
  }
}

const meta: Meta<typeof ProcessPlanning> = {
  title: 'Components/Planner/ProcessPlanning',
  component: ProcessPlanning,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const SingleProject: Story = {
  args: {
    projects: [
      project(
        'КО_505',
        [7, 10], [8, 25],
        [7, 15], [8, 10],
        [7, 30], [8, 20],
      ),
    ],
    origin: '2026-07-01',
  },
}

export const MultipleProjects: Story = {
  args: {
    projects: [
      project('КО_505', [7, 5], [8, 28], [7, 15], [8, 15], [8, 1], [8, 25]),
      project('КО_506', [8, 1], [9, 12], [8, 10], [9, 2], [8, 20], [9, 8]),
      project('КО_512', [7, 20], [9, 5], [7, 25], [8, 25], [8, 15], [9, 1]),
    ],
    origin: '2026-07-01',
  },
}

/** Decades — projects stretch across several decades */
export const YearDecades: Story = {
  args: {
    projects: [
      project('КО_505', [1, 5], [3, 20], [1, 15], [3, 10], [1, 30], [3, 20]),
      project('КО_506', [2, 10], [5, 25], [2, 20], [5, 2], [3, 1], [5, 8]),
    ],
    origin: '2026-01-01',
    unit: 'decade',
  },
}
