import type { Meta, StoryObj } from '@storybook/vue3-vite'
import { reactive, nextTick } from 'vue'
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios'
import { usePlanningStore, useAppStore, useTimesheetStore } from '@/store'
import { expect, fn, waitFor } from 'storybook/test'
import TaskPlanning from './TaskPlanning.vue'
import TimesheetGrid from '@/components/timesheet/TimesheetGrid/TimesheetGrid.vue'
import { makeDemoTimeline } from '../demoTimeline'
import { cachePut, cacheGet, userCachePrefix } from '@/offline/cache'
import { clearOutbox, pendingCount } from '@/offline/outbox'
import { syncNow } from '@/offline/sync'
import { getAccessToken, setAccessToken } from '@/token'
import { isOffline } from '@/offline/state'
import type { DtoDetailedProcess } from '@/api'
import type { PlanningUnit } from '../calendar'

const meta: Meta<typeof TaskPlanning> = {
  title: 'Components/Planner/ResourceRecalculation',
  component: TaskPlanning,
  parameters: { layout: 'fullscreen' },
}
export default meta
type Story = StoryObj<typeof meta>

function scenario(unit: PlanningUnit): Story {
  const commit = fn()
  let planning: ReturnType<typeof usePlanningStore>
  let fixture: DtoDetailedProcess[]
  let app: ReturnType<typeof useAppStore>
  let timesheet: ReturnType<typeof useTimesheetStore>
  let baseCalendar: ReturnType<typeof useAppStore>['calendar']
  return {
    tags: ['vitest'],
    render: () => ({
      components: { TaskPlanning, TimesheetGrid },
      setup() {
        const processes = reactive<DtoDetailedProcess[]>([{
          id: 1, title: 'Resource regression', start_date: '2026-10-01', end_date: '2027-03-01',
          tasks: [
            { id: 7, title: 'Movable', start_date: '2026-11-09', end_date: '2026-11-22', resources: [] },
            { id: 8, title: 'Overlap', start_date: '2026-11-10', end_date: '2026-11-10', resources: [{ id: 1, quantity: 7 }] },
          ],
        }])
        planning = usePlanningStore()
        planning.taskPlanning = { processes }
        fixture = processes
        const resources = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, code: `R${i + 1}`, title: `Resource ${i + 1}` }))
        const calendar = resources.map((r) => ({ resource_id: r.id, periods: [
          { start_date: '2026-10-01', end_date: '2026-11-09', available: 10 },
          { start_date: '2026-11-10', end_date: '2026-11-10', available: 1 },
          { start_date: '2026-11-11', end_date: '2027-03-01', available: 10 },
        ] }))
        app = useAppStore()
        timesheet = useTimesheetStore()
        app.resources = resources
        app.resourceMembers = { 1: [{ id: 51 }] }
        app.calendar = calendar
        baseCalendar = calendar
        timesheet.employees = [{ id: 51, name: 'Employee' }]
        timesheet.states = [{ id: 2, code: 'leave', is_available: false }]
        timesheet.periodsByEmployee = { 51: [] }
        timesheet.windowStart = '2026-11-01'
        timesheet.windowEnd = '2026-11-30'
        function assign() { processes[0].tasks![0].resources = resources.map((r) => ({ id: r.id, assignment_id: 100 + r.id, quantity: r.id + 1 })) }
        function remove() { processes[0].tasks![0].resources = [] }
        return { processes, planning, resources, app, timesheet, sheetTimeline: makeDemoTimeline('2026-11-09', 'day', { viewportCells: 14 }), unit, commit, assign, remove }
      },
      template: `<div style="width:1200px;height:720px"><button data-action="assign" @click="assign">Assign</button><button data-action="remove" @click="remove">Remove</button><TaskPlanning :processes="planning.taskPlanning?.processes" :resources="resources" :calendar="app.calendar" :unit="unit" origin="2026-11-02" focus-date="2026-11-02" @change="commit" /><TimesheetGrid :t="sheetTimeline" :employees="timesheet.employees" :states="timesheet.states" :state-for-day="timesheet.periodFor" :busy="timesheet.busy" /></div>`,
    }),
    play: async ({ canvasElement, step }) => {
      commit.mockClear()
      const cell = (rid: number, date: string) => canvasElement.querySelector<HTMLElement>(`.rs-cell[data-resource-id="${rid}"][data-date="${date}"] .uc-inner`)
      const check = async (rid: number, date: string, text: string) => {
        await waitFor(() => expect(cell(rid, date)?.textContent).toBe(text))
      }
      const sheetAbsent = () => canvasElement.querySelector<HTMLElement>('.ts-cell[data-employee-id="51"][data-cell-index="1"] .tsc-inner')!.style.background !== 'transparent'
      const monday = '2026-11-09'
      await step('assignment and removal recalculate all resource rows', async () => {
        await check(1, monday, unit === 'week' ? '7/1' : '0/10')
        canvasElement.querySelector<HTMLButtonElement>('[data-action="assign"]')!.click()
        for (let rid = 1; rid <= 12; rid++) {
          await check(rid, monday, `${rid + 1 + (unit === 'week' && rid === 1 ? 7 : 0)}/${unit === 'week' ? 1 : 10}`)
        }
        canvasElement.querySelector<HTMLButtonElement>('[data-action="remove"]')!.click()
        await check(1, monday, unit === 'week' ? '7/1' : '0/10')
        await check(12, monday, unit === 'week' ? '0/1' : '0/10')
        canvasElement.querySelector<HTMLButtonElement>('[data-action="assign"]')!.click()
        await nextTick()
      })
      const pointer = (target: EventTarget, type: string, x: number, y: number) => {
        target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y }))
      }
      async function drag(mode: 'move' | 'left' | 'right', delta: number, cancel: boolean) {
        const bar = canvasElement.querySelector<HTMLElement>('.gantt-bar')!
        const target = mode === 'move' ? bar : bar.querySelector<HTMLElement>(mode === 'left' ? '.gb-handle-l' : '.gb-handle-r')!
        const rect = target.getBoundingClientRect()
        const width = canvasElement.querySelector<HTMLElement>('.rs-cell')!.getBoundingClientRect().width
        const x = rect.left + rect.width / 2
        const y = rect.top + rect.height / 2
        pointer(target, 'pointerdown', x, y)
        pointer(window, 'pointermove', x + delta * width, y)
        await nextTick()
        expect(commit).not.toHaveBeenCalled()
        return { move: (cells: number) => pointer(window, 'pointermove', x + cells * width, y), finish: () => pointer(window, cancel ? 'pointercancel' : 'pointerup', x + delta * width, y) }
      }
      await step('held move right and left updates load without committing; cancellation restores it', async () => {
        for (const delta of [1, -1]) {
          const gesture = await drag('move', delta, true)
          const date = delta > 0 ? '2026-11-23' : (unit === 'week' ? '2026-11-02' : '2026-11-08')
          for (let rid = 1; rid <= 12; rid++) await check(rid, date, `${rid + 1}/10`)
          gesture.finish()
          await nextTick()
          await check(12, date, '0/10')
          expect(commit).not.toHaveBeenCalled()
        }
      })
      await step('direction reversal under the same held pointer and no-op release', async () => {
        const gesture = await drag('move', 1, true)
        await check(12, '2026-11-23', '13/10')
        gesture.move(-1)
        await nextTick()
        await check(12, '2026-11-23', '0/10')
        await check(12, unit === 'week' ? '2026-11-02' : '2026-11-08', '13/10')
        gesture.finish()
        await nextTick()
        const noop = await drag('move', 0, false)
        noop.finish()
        await nextTick()
        expect(commit).not.toHaveBeenCalled()
      })
      await step('shrinking either edge removes load for every assigned resource', async () => {
        for (const mode of ['left', 'right'] as const) {
          const gesture = await drag(mode, mode === 'left' ? 1 : -1, true)
          const date = mode === 'left' ? '2026-11-09' : unit === 'week' ? '2026-11-16' : '2026-11-22'
          for (let rid = 2; rid <= 12; rid++) await check(rid, date, `0/${mode === 'left' && unit === 'week' ? 1 : 10}`)
          gesture.finish()
          await nextTick()
        }
      })
      await step('both resize edges update every assigned resource while held', async () => {
        for (const mode of ['left', 'right'] as const) {
          const gesture = await drag(mode, mode === 'left' ? -1 : 1, true)
          const date = mode === 'right' ? '2026-11-23' : unit === 'week' ? '2026-11-02' : '2026-11-08'
          for (let rid = 1; rid <= 12; rid++) await check(rid, date, `${rid + 1}/10`)
          gesture.finish()
          await nextTick()
          await check(12, date, '0/10')
        }
      })
      await step('release commits exactly once with calendar-aligned dates', async () => {
        for (const mode of ['move', 'left', 'right'] as const) {
          commit.mockClear()
          const gesture = await drag(mode, mode === 'left' ? -1 : 1, false)
          gesture.finish()
          await nextTick()
          expect(commit).toHaveBeenCalledTimes(1)
          const start_date = mode === 'right' ? monday : mode === 'left' ? (unit === 'week' ? '2026-11-02' : '2026-11-08') : (unit === 'week' ? '2026-11-16' : '2026-11-10')
          const end_date = mode === 'left' ? '2026-11-22' : unit === 'week' ? '2026-11-29' : '2026-11-23'
          expect(commit).toHaveBeenCalledWith({ id: 7, start_date, end_date })
        }
      })
      await step('real store requests: pending, accepted canonical dates and rejected moves/resizes', async () => {
        const adapter = axios.defaults.adapter
        const original = { start_date: '2026-11-09', end_date: '2026-11-22' }
        try {
          for (const accepted of [true, false]) {
            for (const mode of ['move', 'left', 'right'] as const) {
              Object.assign(fixture[0].tasks![0], original)
              await nextTick()
              const requests: unknown[] = []
              let respond!: () => void
              axios.defaults.adapter = async (config) => {
                if (config.method !== 'put') throw new Error('Reconciliation unavailable')
                requests.push(JSON.parse(config.data as string))
                return new Promise((resolve, reject) => {
                  respond = () => {
                    const response = { data: { data: { id: 7, ...original } }, status: accepted ? 200 : 409, statusText: accepted ? 'OK' : 'Conflict', headers: {}, config }
                    if (accepted) resolve(response)
                    else reject(new AxiosError('Rejected dates', 'ERR_BAD_REQUEST', config, undefined, response))
                  }
                })
              }
              let pending: Promise<boolean> | undefined
              commit.mockClear()
              commit.mockImplementation((p: { id: number; start_date: string; end_date: string }) => {
                pending = planning.moveTask(p.id, p.start_date, p.end_date)
              })
              const gesture = await drag(mode, mode === 'left' ? -1 : 1, false)
              expect(requests).toHaveLength(0)
              const date = mode === 'left' ? (unit === 'week' ? '2026-11-02' : '2026-11-08') : '2026-11-23'
              await check(12, date, '13/10')
              gesture.finish()
              await waitFor(() => expect(requests).toHaveLength(1))
              const proposed = commit.mock.calls[0][0] as { start_date: string; end_date: string }
              expect(requests[0]).toEqual({ start_date: proposed.start_date, end_date: proposed.end_date })
              await check(12, date, '13/10')
              respond()
              await expect(pending).resolves.toBe(accepted)
              await check(12, date, '0/10')
              expect(fixture[0].tasks![0]).toMatchObject(original)
              if (!accepted) expect(planning.error).toBeTruthy()
            }
          }
        } finally {
          axios.defaults.adapter = adapter
          commit.mockReset()
        }
      })
      await step('real assignment requests preview immediately and roll back rejected add/delete', async () => {
        const adapter = axios.defaults.adapter
        const originalResources = fixture[0].tasks![0].resources!
        try {
          for (const mode of ['add', 'delete']) {
            for (const accepted of [true, false]) {
              fixture[0].tasks![0].resources = mode === 'add' ? originalResources.filter((r) => r.id !== 12) : [...originalResources]
              await nextTick()
              let respond!: () => void
              const requests: string[] = []
              axios.defaults.adapter = async (config) => {
                if (config.method === 'get') throw new Error('Reconciliation unavailable')
                requests.push(config.method!)
                if (mode === 'add') expect(JSON.parse(config.data as string)).toEqual({ task_id: 7, resource_id: 12, quantity: 13 })
                else expect(config.url).toMatch(/assignment\/112$/)
                return new Promise((resolve, reject) => {
                  respond = () => {
                    const response = { data: { data: { id: 112 } }, status: accepted ? 200 : 409, statusText: 'Status', headers: {}, config }
                    if (accepted) resolve(response)
                    else reject(new AxiosError('Assignment rejected', 'ERR_BAD_REQUEST', config, undefined, response))
                  }
                })
              }
              const pending = mode === 'add' ? planning.assignResource(7, 12, 13) : planning.removeResource(7, 12)
              await check(12, '2026-11-16', mode === 'add' ? '13/10' : '0/10')
              await check(2, '2026-11-16', '3/10')
              await waitFor(() => expect(requests).toEqual([mode === 'add' ? 'post' : 'delete']))
              respond()
              await expect(pending).resolves.toBe(accepted)
              const assigned = accepted ? mode === 'add' : mode === 'delete'
              await check(12, '2026-11-16', assigned ? '13/10' : '0/10')
            }
          }
        } finally {
          fixture[0].tasks![0].resources = originalResources
          axios.defaults.adapter = adapter
          await nextTick()
        }
      })
      await step('absence add/delete: immediate availability, accepted response and complete rollback', async () => {
        const adapter = axios.defaults.adapter
        const date = unit === 'week' ? '2026-11-09' : '2026-11-10'
        try {
          for (const mode of ['add', 'delete']) {
            for (const accepted of [true, false]) {
              app.calendar = structuredClone(baseCalendar)
              timesheet.periodsByEmployee = { 51: [] }
              const reply = (config: InternalAxiosRequestConfig) => ({ data: { data: null }, status: 200, statusText: 'OK', headers: {}, config })
              axios.defaults.adapter = async (config) => {
                if (config.method === 'get') throw new Error('Reconciliation unavailable')
                return reply(config)
              }
              if (mode === 'delete') await timesheet.assignRange(51, 2, '2026-11-10', '2026-11-10')
              await check(1, date, mode === 'delete' ? '9/0' : '9/1')
              let respond!: () => void
              const requests: string[] = []
              axios.defaults.adapter = async (config) => {
                if (config.method === 'get') throw new Error('Reconciliation unavailable')
                requests.push(config.method!)
                return new Promise((resolve, reject) => {
                  respond = () => {
                    if (accepted) resolve(reply(config))
                    else reject(new AxiosError('Rejected absence', 'ERR_BAD_REQUEST', config, undefined, { ...reply(config), status: 409 }))
                  }
                })
              }
              const pending = mode === 'add'
                ? timesheet.assignRange(51, 2, '2026-11-10', '2026-11-10')
                : timesheet.clearRange(51, '2026-11-10', '2026-11-10')
              await check(1, date, mode === 'add' ? '9/0' : '9/1')
              expect(Boolean(timesheet.periodFor(51, '2026-11-10'))).toBe(mode === 'add')
              expect(sheetAbsent()).toBe(mode === 'add')
              // Adjacent days/weeks and unrelated resource capacity stay unchanged.
              await check(1, unit === 'week' ? '2026-11-16' : '2026-11-11', '2/10')
              await check(2, date, '3/1')
              await waitFor(() => expect(requests).toEqual([mode === 'add' ? 'put' : 'delete']))
              respond()
              await expect(pending).resolves.toBe(accepted)
              const absent = accepted ? mode === 'add' : mode === 'delete'
              await check(1, date, absent ? '9/0' : '9/1')
              expect(Boolean(timesheet.periodFor(51, '2026-11-10'))).toBe(absent)
              expect(sheetAbsent()).toBe(absent)
            }
          }
        } finally {
          axios.defaults.adapter = adapter
          app.calendar = baseCalendar
          timesheet.periodsByEmployee = { 51: [] }
        }
      })
      await step('offline persistence, cache hydration and queue-first recovery', async () => {
        const adapter = axios.defaults.adapter
        const fetch = window.fetch
        const token = getAccessToken()
        const cacheKey = userCachePrefix() + '/api/v1/planning/tasks'
        const original = JSON.parse(JSON.stringify(planning.taskPlanning))
        const proposed = { start_date: '2026-11-16', end_date: '2026-11-29' }
        try {
          await clearOutbox()
          await cachePut(cacheKey, { data: original })
          isOffline.value = true
          axios.defaults.adapter = async (config) => { throw new AxiosError('Network Error', 'ERR_NETWORK', config) }
          await expect(planning.moveTask(7, proposed.start_date, proposed.end_date)).resolves.toBe(true)
          expect(pendingCount.value).toBe(1)
          await check(12, '2026-11-23', '13/10')
          const saved = await cacheGet<{ data: { processes: DtoDetailedProcess[] } }>(cacheKey)
          expect(saved!.data.processes[0].tasks![0]).toMatchObject(proposed)
          // Simulate rebuilding the planning store from persistent offline data.
          planning.taskPlanning = null
          await planning.loadTaskPlanning()
          expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject(proposed)
          await check(12, '2026-11-23', '13/10')
          axios.defaults.adapter = async (config) => ({ status: 200, statusText: 'OK', headers: {}, config, data: { data: original } })
          await planning.refreshTaskPlanning(true)
          expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject(proposed)
          const canonical = JSON.parse(JSON.stringify(original))
          Object.assign(canonical.processes[0].tasks[0], proposed)
          const order: string[] = []
          let accept!: () => void
          window.fetch = async () => new Response('{}', { status: 200 })
          axios.defaults.adapter = async (config) => {
            if (config.method === 'put') {
              order.push('put')
              return new Promise((resolve) => { accept = () => resolve({ status: 200, statusText: 'OK', headers: {}, config, data: { data: { id: 7, ...proposed } } }) })
            }
            order.push('get')
            const data = config.url?.includes('/planning/tasks') ? canonical : { projects: [], items: [] }
            return { status: 200, statusText: 'OK', headers: {}, config, data: { data } }
          }
          isOffline.value = false
          setAccessToken(`e30.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.fixture`)
          const recovering = syncNow()
          await waitFor(() => expect(order).toEqual(['put']))
          await check(12, '2026-11-23', '13/10')
          accept()
          await recovering
          expect(pendingCount.value).toBe(0)
          expect(order[0]).toBe('put')
          expect(order.slice(1)).toContain('get')
          expect(planning.taskPlanning!.processes![0].tasks![0]).toMatchObject(proposed)
          await check(12, '2026-11-23', '13/10')
        } finally {
          await clearOutbox()
          axios.defaults.adapter = adapter
          window.fetch = fetch
          setAccessToken(token)
          isOffline.value = false
        }
      })
    },
  }
}
export const Days = scenario('day')
export const Weeks = scenario('week')
