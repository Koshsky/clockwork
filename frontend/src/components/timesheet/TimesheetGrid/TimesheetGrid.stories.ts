import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TimesheetGrid from './TimesheetGrid.vue'
import { makeDemoTimeline } from '../../planner/demoTimeline'

const meta: Meta<typeof TimesheetGrid> = {
  title: 'Components/Timesheet/TimesheetGrid',
  component: TimesheetGrid,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

const employees = [
  { id: 1, position: 'Инженер', name: 'Иванов Иван Иванович', manager_id: 5 },
  { id: 2, position: 'Инженер', name: 'Петров Пётр Петрович', manager_id: 5 },
  { id: 3, position: 'Монтажник', name: 'Фёдоров Фёдор Фёдорович', manager_id: 5 },
]

const states = [
  { id: 4, code: 'ОТП', name: 'Отпуск', is_available: false },
  { id: 5, code: 'Б', name: 'Больничный', is_available: false },
  { id: 2, code: 'К', name: 'Командировка', is_available: true },
]

const periods: Record<number, { start_date: string; end_date: string; state_code: string; state_name: string; state_id: number; is_available: boolean; id: number }[]> = {
  1: [{ id: 10, state_id: 4, state_code: 'ОТП', state_name: 'Отпуск', is_available: false, start_date: '2026-07-20', end_date: '2026-08-02' }],
  2: [{ id: 11, state_id: 5, state_code: 'Б', state_name: 'Больничный', is_available: false, start_date: '2026-07-27', end_date: '2026-08-05' }],
}

export const Default: Story = {
  render: () => ({
    components: { TimesheetGrid },
    data: () => ({
      t: makeDemoTimeline('2026-07-15', 'day', { viewportCells: 40 }),
      employees,
      states,
    }),
    methods: {
      stateForDay(id: number, iso: string) {
        return (periods[id] ?? []).find((p) => iso >= p.start_date && iso <= p.end_date)
      },
    },
    template: `
      <div style="width:1400px;">
        <TimesheetGrid :t="t" :employees="employees" :states="states" :stateForDay="stateForDay" />
      </div>
    `,
  }),
}
