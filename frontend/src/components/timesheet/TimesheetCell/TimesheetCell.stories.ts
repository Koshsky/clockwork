import type { Meta, StoryObj } from '@storybook/vue3-vite'
import TimesheetCell from './TimesheetCell.vue'

const meta: Meta<typeof TimesheetCell> = {
  title: 'Components/Timesheet/TimesheetCell',
  component: TimesheetCell,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
}

export default meta
type Story = StoryObj<typeof meta>

const states = {
  vacation: { id: 1, state_id: 4, state_code: 'ОТП', state_name: 'Отпуск', is_available: false, start_date: '2026-07-20', end_date: '2026-08-02' },
  sick: { id: 2, state_id: 5, state_code: 'Б', state_name: 'Больничный', is_available: false, start_date: '2026-07-27', end_date: '2026-08-05' },
  trip: { id: 3, state_id: 2, state_code: 'К', state_name: 'Командировка', is_available: true, start_date: '2026-08-01', end_date: '2026-08-07' },
}

export const AllCells: Story = {
  render: () => ({
    components: { TimesheetCell },
    data: () => ({ states }),
    template: `
      <div style="display:flex;gap:6px;font-family:sans-serif;">
        <div style="width:36px;height:26px;"><TimesheetCell /></div>
        <div style="width:36px;height:26px;"><TimesheetCell :is-weekend="true" /></div>
        <div style="width:36px;height:26px;"><TimesheetCell :state="states.vacation" /></div>
        <div style="width:36px;height:26px;"><TimesheetCell :state="states.sick" /></div>
        <div style="width:36px;height:26px;"><TimesheetCell :state="states.trip" /></div>
        <div style="width:36px;height:26px;"><TimesheetCell :state="states.vacation" :selected="true" /></div>
      </div>
    `,
  }),
}
