import type { Meta, StoryObj } from '@storybook/vue3-vite'
import ProjectPlanning from './ProjectPlanning.vue'

const now = new Date()
const y = now.getFullYear()
const day = (month: number, d: number) => new Date(y, month - 1, d)
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

let idSeq = 0
const project = (
  code: string,
  start: [number, number],
  end: [number, number],
) => {
  idSeq += 1
  return {
    id: idSeq,
    project_code: code,
    start_date: iso(day(start[0], start[1])),
    end_date: iso(day(end[0], end[1])),
  }
}

const meta: Meta<typeof ProjectPlanning> = {
  title: 'Components/Planner/ProjectPlanning',
  component: ProjectPlanning,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

export const SingleProject: Story = {
  args: { projects: [project('КО_505-S-ПТЗ_БСМП_МВС', [7, 15], [9, 20])], origin: '2026-07-01' },
}

export const MultipleProjects: Story = {
  args: {
    projects: [
      project('КО_505-S-ПТЗ_БСМП_МВС', [7, 15], [9, 20]),
      project('КО_506-S-СПБ_ГБ_ТЕЛЕМЕД', [8, 1], [11, 5]),
      project('КО_512-S-КРД_ОДКБ_ВИДЕО', [6, 20], [10, 15]),
    ],
    origin: '2026-07-01',
  },
}

export const WithDecades: Story = {
  args: {
    projects: [
      project('КО_505-S-ПТЗ_БСМП_МВС', [7, 15], [9, 20]),
      project('КО_506-S-СПБ_ГБ_ТЕЛЕМЕД', [8, 5], [11, 10]),
    ],
    origin: '2026-07-01',
    unit: 'decade',
  },
}

/** Empty DB: a centered «Новый проект» action (the page creates with today's date) */
export const Empty: Story = {
  args: {
    projects: [],
    origin: '2026-07-01',
    canCreate: true,
  },
}


