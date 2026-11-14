import { expect, it, vi } from 'vitest'
// @ts-expect-error Node fixture loading is test-only; the renderer intentionally has no Node types.
import { createRequire } from 'node:module'
import { acknowledgeDesktopPreconditions, captureDesktopPreconditions, observeDesktopCommand, type DesktopBaseline, type DesktopBaselineRequest, type DesktopPreconditionsSources } from './desktopPreconditions'

const { decorateSnapshot, applyOwnConfirmation } = createRequire(import.meta.url)('../../../desktop/command-baseline.cjs') as { decorateSnapshot: <T>(snapshot: T, revisions: DesktopBaseline, route: string) => T; applyOwnConfirmation: <T>(snapshot: T, revisions: DesktopBaseline, route: string, dto: unknown, sourceRoute: string) => T }
interface Base { id: number; _baseline?: DesktopBaseline; _pending?: Record<string, string> }
interface Task extends Base { title: string; process_id?: number; resources: Badge[]; subtasks?: Task[] }
interface Badge extends Base { assignment_id: number; quantity: number; _baseline?: DesktopBaseline }
interface Process extends Base { project_id?: number; title: string; tasks: Task[]; milestones: Array<Base & { title: string; date: string; process_id?: number }> }
interface Project extends Base { project_code: string; processes?: Process[] }
interface Resource extends Base { code: string; title: string }
interface State extends Base { code: string; name: string; is_available: boolean }

function fixture() {
  const revisions = { 'project:1': 'pr1', 'project:2': 'pr2', 'process:3': 'p3', 'process:4': 'p4', 'resource:5': 'r5', 'resource:6': 'r6', states: 's' }
  const planningProjects = decorateSnapshot({ projects: [{ id: 1, project_code: 'P1' }, { id: 2, project_code: 'P2' }] as Project[] }, revisions, 'GET /planning/projects')
  const planningTasks = decorateSnapshot({ processes: [
    { id: 3, project_id: 1, title: 'Process3', tasks: [{ id: 7, process_id: 3, title: 'Task7', resources: [{ id: 5, assignment_id: 9, quantity: 1 }], subtasks: [{ id: 8, process_id: 3, title: 'Subtask8', resources: [] }] }], milestones: [{ id: 10, process_id: 3, title: 'Milestone', date: '2026-11-13' }] },
    { id: 4, project_id: 2, title: 'Process4', tasks: [{ id: 11, process_id: 4, title: 'Task11', resources: [] }], milestones: [] },
  ] as Process[] }, revisions, 'GET /planning/tasks')
  const resources = decorateSnapshot([{ id: 5, code: 'R5', title: 'Resource5' }, { id: 6, code: 'R6', title: 'Resource6' }] as Resource[], revisions, 'GET /resources')
  const states = decorateSnapshot([{ id: 12, code: 'A', name: 'Available', is_available: true }] as State[], revisions, 'GET /timesheet/states')
  const periodBaseline = vi.fn(() => ({ 'user_days:13': 'u13', states: 's' }))
  const sources: DesktopPreconditionsSources = { planningProjects, planningTasks, resources, states, periodBaseline }
  return { sources, planningProjects, planningTasks, resources, states, periodBaseline, task: planningTasks.processes[0]!.tasks[0]!, process: planningTasks.processes[0]!, badge: planningTasks.processes[0]!.tasks[0]!.resources[0]! }
}

const routeCases: Array<[string, DesktopBaselineRequest, DesktopBaseline]> = [
  ['POST /project', { body: { owner_id: 77 } }, {}],
  ['PUT /project/{id}', { path: { id: '1' } }, { 'project:1': 'pr1' }],
  ['DELETE /project/{id}', { path: { id: '1' } }, { 'project:1': 'pr1' }],
  ['POST /process', { body: { project_id: 1 } }, { 'project:1': 'pr1' }],
  ['PUT /process/order', { body: { project_id: 1, ids: [3] } }, { 'project:1': 'pr1' }],
  ['PUT /process/{id}', { path: { id: 3 }, body: { owner_id: 77 } }, { 'process:3': 'p3' }],
  ['DELETE /process/{id}', { path: { id: 3 } }, { 'process:3': 'p3' }],
  ['POST /task', { body: { process_id: 3, owner_id: 77 } }, { 'process:3': 'p3' }],
  ['PUT /task/order', { body: { process_id: 3, ids: [7] } }, { 'process:3': 'p3' }],
  ['PUT /task/{id}', { path: { id: 7 }, body: { owner_id: 77 } }, { 'process:3': 'p3' }],
  ['DELETE /task/{id}', { path: { id: 7 } }, { 'process:3': 'p3' }],
  ['POST /task/{id}/dependencies', { path: { id: 7 }, body: { depends_on_task_id: 8, type: 'fs' } }, { 'process:3': 'p3' }],
  ['PUT /task/{id}/dependencies/{dep_id}', { path: { id: 7, dep_id: 5 }, body: { type: 'ss' } }, { 'process:3': 'p3' }],
  ['DELETE /task/{id}/dependencies/{dep_id}', { path: { id: 7, dep_id: 5 } }, { 'process:3': 'p3' }],
  ['POST /milestone', { body: { process_id: 3, date: '2026-11-13' } }, { 'process:3': 'p3' }],
  ['PUT /milestone/{id}', { path: { id: 10 }, body: { process_id: 3 } }, { 'process:3': 'p3' }],
  ['DELETE /milestone/{id}', { path: { id: 10 } }, { 'process:3': 'p3' }],
  ['POST /assignment', { body: { task_id: 7, resource_id: 5, quantity: 2 } }, { 'process:3': 'p3', 'resource:5': 'r5' }],
  ['PUT /assignment/{id}', { path: { id: 9 }, body: { quantity: 3 } }, { 'process:3': 'p3', 'resource:5': 'r5' }],
  ['DELETE /assignment/{id}', { path: { id: 9 } }, { 'process:3': 'p3', 'resource:5': 'r5' }],
  ['POST /resources', { body: { owner_id: 77 } }, {}],
  ['PUT /resources/{id}', { path: { id: 5 } }, { 'resource:5': 'r5' }],
  ['DELETE /resources/{id}', { path: { id: 5 } }, { 'resource:5': 'r5' }],
  ['POST /resources/{id}/members', { path: { id: 5 }, body: { user_id: 77 } }, { 'resource:5': 'r5' }],
  ['DELETE /resources/{id}/members/{userId}', { path: { id: 5, userId: 77 } }, { 'resource:5': 'r5' }],
  ['POST /timesheet/states', { body: { code: 'B' } }, { states: 's' }],
  ['PUT /timesheet/states/{id}', { path: { id: 12 } }, { states: 's' }],
  ['DELETE /timesheet/states/{id}', { path: { id: 12 } }, { states: 's' }],
  ['PUT /user/{id}/days', { path: { id: 13 }, body: { start_date: '2026-11-01', end_date: '2026-11-02', state_id: 12 } }, { 'user_days:13': 'u13', states: 's' }],
  ['DELETE /user/{id}/days', { path: { id: 13 }, query: { start_date: '2026-11-01', end_date: '2026-11-02' } }, { 'user_days:13': 'u13', states: 's' }],
]

it.each(routeCases)('captures exact guards for %s', (route, request, expected) => {
  expect(captureDesktopPreconditions({ ...request, route }, fixture().sources)).toEqual(expected)
})

it('returns undefined for online-only and read routes without inspecting missing baselines', () => {
  for (const route of ['GET /task/{id}', 'POST /user', 'PUT /user/{id}', 'POST /task/{id}/comments', 'PUT /rbac/presets/{id}', 'POST /auth/login']) expect(captureDesktopPreconditions({ route }, {})).toBeUndefined()
})

it('accepts the native operation alias without mutating the request or sources', () => {
  const f = fixture(), request = { operation: 'PUT /task/{id}', path: { id: 7 }, body: { title: 'new' } }, before = JSON.stringify(f.sources)
  expect(captureDesktopPreconditions(request, f.sources)).toEqual({ 'process:3': 'p3' })
  expect(JSON.stringify(f.sources)).toBe(before)
  expect(request.body).toEqual({ title: 'new' })
})

it('inherits task and subtask process context when DTO fields are absent', () => {
  const f = fixture()
  delete f.task.process_id; delete f.task.subtasks![0]!.process_id
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 8 } }, f.sources)).toEqual({ 'process:3': 'p3' })
})

it('does not lend a newer parent marker to a stale positive task', () => {
  const f = fixture(); f.task._baseline = { 'process:3': 'old-task' }; f.process._baseline = { 'process:3': 'new-parent' }
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, f.sources)).toEqual({ 'process:3': 'old-task' })
})

it('rejects a positive task without its own source marker', () => {
  const f = fixture(); delete f.task._baseline
  expect(() => captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, f.sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('rejects missing required resources instead of using the task process token alone', () => {
  const f = fixture(); f.sources.resources = []
  expect(() => captureDesktopPreconditions({ route: 'POST /assignment', body: { task_id: 7, resource_id: 5 } }, f.sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('joins a new project only when a process actually changes its project', () => {
  const f = fixture()
  expect(captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 }, body: { project_id: 1 } }, f.sources)).toEqual({ 'process:3': 'p3' })
  expect(captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 }, body: { project_id: 2 } }, f.sources)).toEqual({ 'process:3': 'p3', 'project:2': 'pr2' })
})

it('joins old and destination aggregates for moved milestones and assignments', () => {
  const f = fixture()
  expect(captureDesktopPreconditions({ route: 'PUT /milestone/{id}', path: { id: 10 }, body: { process_id: 4 } }, f.sources)).toEqual({ 'process:3': 'p3', 'process:4': 'p4' })
  expect(captureDesktopPreconditions({ route: 'PUT /assignment/{id}', path: { id: 9 }, body: { task_id: 11, resource_id: 6 } }, f.sources)).toEqual({ 'process:3': 'p3', 'resource:5': 'r5', 'process:4': 'p4', 'resource:6': 'r6' })
})

it('unchanged assignment parents do not borrow newer parent markers', () => {
  const f = fixture(); f.task._baseline = { 'process:3': 'new-parent' }; f.resources[0]!._baseline = { 'resource:5': 'new-resource' }
  expect(captureDesktopPreconditions({ route: 'PUT /assignment/{id}', path: { id: 9 }, body: { task_id: 7, resource_id: 5 } }, f.sources)).toEqual({ 'process:3': 'p3', 'resource:5': 'r5' })
})

it('rejects contradictory tokens when dependency endpoints share a process', () => {
  const f = fixture(); f.task.subtasks![0]!._baseline = { 'process:3': 'other' }
  expect(() => captureDesktopPreconditions({ route: 'POST /task/{id}/dependencies', path: { id: 7 }, body: { depends_on_task_id: 8 } }, f.sources)).toThrow('COMMAND_BASELINE_AMBIGUOUS')
})

it('prefers the process chart over a different historical task chart copy', () => {
  const f = fixture()
  f.sources.planningProcesses = decorateSnapshot({ projects: [{ id: 1, processes: [{ id: 3, project_id: 1 }] }] }, { 'project:1': 'pr1', 'process:3': 'other' }, 'GET /planning/processes')
  expect(captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 } }, f.sources)).toEqual({ 'process:3': 'other' })
})

it('rejects contradictory parents even when their token keys differ', () => {
  const f = fixture()
  f.sources.planningProcesses = decorateSnapshot({ projects: [{ id: 1, processes: [{ id: 3, project_id: 1 }] }, { id: 2, processes: [{ id: 3, project_id: 2 }] }] }, { 'project:1': 'pr1', 'project:2': 'pr2', 'process:3': 'p3' }, 'GET /planning/processes')
  expect(() => captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 } }, f.sources)).toThrow('COMMAND_BASELINE_AMBIGUOUS')
})

it('root creates need no earlier entities or owner baselines', () => {
  expect(captureDesktopPreconditions({ route: 'POST /project', body: { owner_id: 999 } }, {})).toEqual({})
  expect(captureDesktopPreconditions({ route: 'POST /resources', body: { owner_id: 999 } }, {})).toEqual({})
})

it('a negative new parent remains pending until its creator acknowledgement', () => {
  expect(captureDesktopPreconditions({ route: 'POST /process', body: { project_id: -1 } }, {})).toEqual({ 'project:-1': 'pending' })
  expect(captureDesktopPreconditions({ route: 'POST /task', body: { process_id: -2 } }, {})).toEqual({ 'process:-2': 'pending' })
})

it('optimistic negative tasks may use their loaded parent before they have a source marker', () => {
  const f = fixture(); f.process.tasks.push({ id: -7, title: 'Local', resources: [] })
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: -7 } }, f.sources)).toEqual({ 'process:3': 'p3' })
})

it('negative task and assignment descendants retain creator placeholders', () => {
  const sources = { planningTasks: { processes: [{ id: -3, tasks: [{ id: -7, resources: [{ id: -5, assignment_id: -9 }] }] }] } }
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: -7 } }, sources)).toEqual({ 'process:-3': 'pending' })
  expect(captureDesktopPreconditions({ route: 'PUT /assignment/{id}', path: { id: -9 } }, sources)).toEqual({ 'process:-3': 'pending', 'resource:-5': 'pending' })
})

it('empty day-kind creation uses the exact catalog sidecar', () => {
  expect(captureDesktopPreconditions({ route: 'POST /timesheet/states' }, { states: [], stateBaseline: { states: 'empty-catalog' } })).toEqual({ states: 'empty-catalog' })
  expect(() => captureDesktopPreconditions({ route: 'POST /timesheet/states' }, { states: [] })).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('a contradictory day-kind sidecar does not override displayed state rows', () => {
  const f = fixture(); f.sources.stateBaseline = { states: 'different' }
  expect(() => captureDesktopPreconditions({ route: 'POST /timesheet/states' }, f.sources)).toThrow('COMMAND_BASELINE_AMBIGUOUS')
})

it('period lookup uses the exact edited range and requires both worker and kind tokens', () => {
  const f = fixture()
  captureDesktopPreconditions({ route: 'DELETE /user/{id}/days', path: { id: 13 }, query: { start_date: '2026-11-01', end_date: '2026-11-02' } }, f.sources)
  expect(f.periodBaseline).toHaveBeenCalledWith(13, '2026-11-01', '2026-11-02')
  f.sources.periodBaseline = () => ({ 'user_days:13': 'u13' })
  expect(() => captureDesktopPreconditions({ route: 'PUT /user/{id}/days', path: { id: 13 }, body: { start_date: '2026-11-01', end_date: '2026-11-02' } }, f.sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('different entity types sharing an ID never lend each other a baseline', () => {
  const sources = { planningProjects: { projects: [{ id: 3, _baseline: { 'project:3': 'project' } }] }, resources: [{ id: 3, _baseline: { 'resource:3': 'resource' } }] }
  expect(() => captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 } }, sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('does not trust preconditions injected into the request body', () => {
  const f = fixture()
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 }, body: { _preconditions: { 'process:3': 'forged-new' } } }, f.sources)).toEqual({ 'process:3': 'p3' })
})

it('acknowledges only the target task, preserving parent, sibling and assignment markers', () => {
  const f = fixture(), beforeParent = f.process._baseline, beforeSubtask = f.task.subtasks![0]!._baseline, beforeBadge = f.badge._baseline
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Confirmed', owner_id: 77 }, { 'process:3': 'p-new', 'resource:5': 'r-new' }, f.sources)
  expect(f.task.title).toBe('Confirmed'); expect(f.task._baseline).toEqual({ 'process:3': 'p-new' })
  expect(f.process._baseline).toBe(beforeParent); expect(f.task.subtasks![0]!._baseline).toBe(beforeSubtask); expect(f.badge._baseline).toBe(beforeBadge)
})

it('own project acknowledgement updates aliases without advancing cascading processes', () => {
  const f = fixture()
  acknowledgeDesktopPreconditions({ route: 'PUT /project/{id}', path: { id: 1 } }, { id: 1, code: 'Confirmed' }, { 'project:1': 'new', 'process:3': 'cascaded' }, f.sources)
  expect(f.planningProjects.projects[0]!.project_code).toBe('Confirmed')
  expect(f.planningProjects.projects[0]!._baseline).toEqual({ 'project:1': 'new' })
  expect(f.process._baseline).toEqual({ 'process:3': 'p3' })
})

it('assignment acknowledgement keeps assignment and resource identifiers distinct', () => {
  const f = fixture()
  acknowledgeDesktopPreconditions({ route: 'PUT /assignment/{id}', path: { id: 9 } }, { id: 9, task_id: 7, resource_id: 6, quantity: 4 }, { 'process:3': 'p-new', 'resource:6': 'r-new' }, f.sources)
  expect(f.badge.id).toBe(6); expect(f.badge.assignment_id).toBe(9); expect(f.badge.quantity).toBe(4)
  expect(f.badge._baseline).toEqual({ 'process:3': 'p-new', 'resource:6': 'r-new' })
  expect(f.task._baseline).toEqual({ 'process:3': 'p3' })
})

it('acknowledgements for a different target or a delete do not lend tokens', () => {
  const f = fixture(), original = JSON.stringify(f.sources)
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 11, process_id: 4, title: 'Wrong target' }, { 'process:4': 'new' }, f.sources)
  acknowledgeDesktopPreconditions({ route: 'DELETE /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3 }, { 'process:3': 'new' }, f.sources)
  expect(JSON.stringify(f.sources)).toBe(original)
})

it('missing acknowledgement metadata preserves the previous marker', () => {
  const f = fixture()
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Confirmed' }, {}, f.sources)
  expect(f.task.title).toBe('Confirmed'); expect(f.task._baseline).toEqual({ 'process:3': 'p3' })
})

it('empty or malformed IDs cannot accidentally select another row', () => {
  for (const id of [0, '', '07', '1.2', Number.MAX_SAFE_INTEGER + 1]) expect(() => captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id } }, fixture().sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('rejects contradictory tokens within the selected source itself', () => {
  const f = fixture()
  f.sources.planningProcesses = { projects: [{ id: 1, processes: [{ id: 3, _baseline: { 'process:3': 'one' } }, { id: 3, _baseline: { 'process:3': 'two' } }] }] }
  expect(() => captureDesktopPreconditions({ route: 'PUT /process/{id}', path: { id: 3 } }, f.sources)).toThrow('COMMAND_BASELINE_AMBIGUOUS')
})

it('does not merge a historical parent project copy into the primary project chart', () => {
  const f = fixture()
  f.sources.planningProcesses = { projects: [{ id: 1, _baseline: { 'project:1': 'historical' } }] }
  expect(captureDesktopPreconditions({ route: 'PUT /project/{id}', path: { id: 1 } }, f.sources)).toEqual({ 'project:1': 'pr1' })
})

it.each([
  ['project', 'PUT /project/{id}', 1, { id: 1, code: 'Confirmed', priority: 9 }, { 'project:1': 'new-project' }, 'GET /planning/projects'],
  ['process', 'PUT /process/{id}', 3, { id: 3, project_id: 1, title: 'Confirmed' }, { 'process:3': 'new-process' }, 'GET /planning/tasks'],
  ['task', 'PUT /task/{id}', 7, { id: 7, process_id: 3, title: 'Confirmed' }, { 'process:3': 'new-process' }, 'GET /planning/tasks'],
  ['resource', 'PUT /resources/{id}', 5, { id: 5, code: 'Confirmed', title: 'Confirmed' }, { 'resource:5': 'new-resource' }, 'GET /resources'],
  ['assignment', 'PUT /assignment/{id}', 9, { id: 9, task_id: 7, resource_id: 6, quantity: 4 }, { 'process:3': 'new-process', 'resource:6': 'new-resource' }, 'GET /planning/tasks'],
] as const)('matches CJS authoritative confirmation shape for %s', (kind, route, id, dto, revisions, sourceRoute) => {
  const native = fixture(), renderer = fixture()
  const nativeSnapshot = kind === 'project' ? native.planningProjects : kind === 'resource' ? native.resources : native.planningTasks
  const rendererSnapshot = kind === 'project' ? renderer.planningProjects : kind === 'resource' ? renderer.resources : renderer.planningTasks
  applyOwnConfirmation(nativeSnapshot, revisions, route, dto, sourceRoute)
  acknowledgeDesktopPreconditions({ route, path: { id } }, dto, revisions, renderer.sources)
  expect(rendererSnapshot).toEqual(nativeSnapshot)
})

it('a later fresh GET must not be overwritten by an earlier acknowledgement after apply refreshes', () => {
  const f = fixture(); f.task.title = 'Fresh external P3'; f.task._baseline = { 'process:3': 'p3-newer' }
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Earlier own P2' }, { 'process:3': 'p2-ack' }, f.sources, { 'process:3': 'p1-original' })
  expect(f.task.title).toBe('Fresh external P3')
  expect(f.task._baseline).toEqual({ 'process:3': 'p3-newer' })
})

it('an acknowledgement advances its captured source or the same already refreshed ACK version', () => {
  const f = fixture()
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Own' }, { 'process:3': 'ack' }, f.sources, { 'process:3': 'p3' })
  expect(f.task.title).toBe('Own'); expect(f.task._baseline).toEqual({ 'process:3': 'ack' })
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Same ACK' }, { 'process:3': 'ack' }, f.sources, { 'process:3': 'p3' })
  expect(f.task.title).toBe('Same ACK')
})

it('manual optimistic constructors without a marker can adopt their confirmed DTO', () => {
  const f = fixture(); delete f.task._baseline
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Confirmed' }, { 'process:3': 'ack' }, f.sources, { 'process:3': 'p3' })
  expect(f.task.title).toBe('Confirmed'); expect(f.task._baseline).toEqual({ 'process:3': 'ack' })
})

it('a new negative state may be edited and deleted from the same catalog source', () => {
  const f = fixture(); f.states.push({ id: -12, code: 'Local', name: 'Local', is_available: false })
  f.sources.stateBaseline = { states: 's' }
  expect(captureDesktopPreconditions({ route: 'PUT /timesheet/states/{id}', path: { id: -12 } }, f.sources)).toEqual({ states: 's' })
  expect(captureDesktopPreconditions({ route: 'DELETE /timesheet/states/{id}', path: { id: -12 } }, f.sources)).toEqual({ states: 's' })
  expect(captureDesktopPreconditions({ route: 'POST /timesheet/states' }, f.sources)).toEqual({ states: 's' })
})

it('a negative state can use an empty catalog sidecar but positive missing markers still fail closed', () => {
  const states: State[] = [{ id: -1, code: 'Local', name: 'Local', is_available: false }]
  expect(captureDesktopPreconditions({ route: 'PUT /timesheet/states/{id}', path: { id: -1 } }, { states, stateBaseline: { states: 'empty' } })).toEqual({ states: 'empty' })
  states.push({ id: 2, code: 'Existing', name: 'Existing', is_available: false })
  expect(() => captureDesktopPreconditions({ route: 'PUT /timesheet/states/{id}', path: { id: 2 } }, { states, stateBaseline: { states: 'empty' } })).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('same-window edits prove their observed predecessor while an untouched stale window keeps its UUID', () => {
  const own = fixture(), stale = fixture()
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }, 'operation-A', own.sources)
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, own.sources)).toEqual({ 'process:3': 'local:operation-A' })
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, stale.sources)).toEqual({ 'process:3': 'p3' })
  expect(own.task._baseline).toEqual({ 'process:3': 'p3' })
})

it('only rows of the actually updated chart with the captured version receive pending provenance', () => {
  const f = fixture()
  f.sources.planningProcesses = { projects: [{ id: 1, processes: [structuredClone(f.process)] }] }
  f.task.subtasks![0]!._baseline = { 'process:3': 'newer-get' }
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }, 'operation-A', f.sources)
  expect(f.process._pending).toEqual({ 'process:3': 'operation-A' })
  expect(f.badge._pending).toEqual({ 'process:3': 'operation-A' })
  expect(f.task.subtasks![0]!._pending).toBeUndefined()
  const other = f.sources.planningProcesses as { projects: Array<{ processes: Process[] }> }
  expect(other.projects[0]!.processes[0]!._pending).toBeUndefined()
  expect(f.resources[0]!._pending).toBeUndefined()
})

it('a second observed edit advances its local predecessor tag without changing the server baseline', () => {
  const f = fixture(), request = { route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }
  observeDesktopCommand(request, 'first', f.sources)
  observeDesktopCommand({ ...request, preconditions: { 'process:3': 'local:first' } }, 'second', f.sources)
  expect(f.task._baseline).toEqual({ 'process:3': 'p3' })
  expect(f.task._pending).toEqual({ 'process:3': 'second' })
  expect(captureDesktopPreconditions(request, f.sources)).toEqual({ 'process:3': 'local:second' })
})

it('observation does not mark rows that already carry a different pending predecessor', () => {
  const f = fixture(); f.task._pending = { 'process:3': 'newer-local' }
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }, 'older', f.sources)
  expect(f.task._pending).toEqual({ 'process:3': 'newer-local' })
})

it('queued child creation uses the task-chart parent rather than a different historical process chart', () => {
  const f = fixture()
  f.sources.planningProcesses = { projects: [{ id: 1, processes: [{ id: 3, _baseline: { 'process:3': 'historical' } }] }] }
  expect(captureDesktopPreconditions({ route: 'POST /task', body: { process_id: 3 } }, f.sources)).toEqual({ 'process:3': 'p3' })
  observeDesktopCommand({ route: 'POST /task', body: { process_id: 3 }, preconditions: { 'process:3': 'p3' } }, 'created-task', f.sources)
  expect(captureDesktopPreconditions({ route: 'POST /task', body: { process_id: 3 } }, f.sources)).toEqual({ 'process:3': 'local:created-task' })
})

it('process creation observes the process-chart project source without marking the project chart', () => {
  const f = fixture()
  const project: Project = { id: 1, project_code: 'P1', processes: [], _baseline: { 'project:1': 'process-chart' } }
  f.sources.planningProcesses = { projects: [project] }
  expect(captureDesktopPreconditions({ route: 'POST /process', body: { project_id: 1 } }, f.sources)).toEqual({ 'project:1': 'process-chart' })
  observeDesktopCommand({ route: 'POST /process', body: { project_id: 1 }, preconditions: { 'project:1': 'process-chart' } }, 'created-process', f.sources)
  expect(captureDesktopPreconditions({ route: 'POST /process', body: { project_id: 1 } }, f.sources)).toEqual({ 'project:1': 'local:created-process' })
  expect(f.planningProjects.projects[0]!._pending).toBeUndefined()
})

it('root project creators seed their own negative aggregate and causal identity', () => {
  const project: Project = { id: -1, project_code: 'Local' }, sources = { planningProjects: { projects: [project] } }
  observeDesktopCommand({ route: 'POST /project', preconditions: {} }, 'project-creator', sources, -1)
  expect(project._baseline).toEqual({ 'project:-1': 'pending' })
  expect(project._pending).toEqual({ 'project:-1': 'project-creator' })
  expect(captureDesktopPreconditions({ route: 'PUT /project/{id}', path: { id: -1 } }, sources)).toEqual({ 'project:-1': 'local:project-creator' })
})

it('root resource creators seed the negative resource without tagging unrelated resources', () => {
  const f = fixture(), resource: Resource = { id: -5, code: 'Local', title: 'Local' }; f.resources.push(resource)
  observeDesktopCommand({ route: 'POST /resources', preconditions: {} }, 'resource-creator', f.sources, -5)
  expect(resource._baseline).toEqual({ 'resource:-5': 'pending' })
  expect(captureDesktopPreconditions({ route: 'PUT /resources/{id}', path: { id: -5 } }, f.sources)).toEqual({ 'resource:-5': 'local:resource-creator' })
  expect(f.resources[0]!._pending).toBeUndefined()
})

it('new processes and tasks get their own creator provenance after optimistic constructors dropped metadata', () => {
  const process: Process = { id: -3, project_id: 1, title: 'Local', tasks: [], milestones: [] }
  const project: Project = { id: 1, project_code: 'P1', processes: [process], _baseline: { 'project:1': 'pr1' } }
  const sources = { planningProcesses: { projects: [project] }, planningTasks: { processes: [process] } }
  observeDesktopCommand({ route: 'POST /process', preconditions: { 'project:1': 'pr1' } }, 'process-creator', sources, -3)
  expect(process._baseline).toEqual({ 'process:-3': 'pending' })
  const task: Task = { id: -7, title: 'Local child', process_id: -3, resources: [] }; process.tasks.push(task)
  observeDesktopCommand({ route: 'POST /task', body: { process_id: -3 }, preconditions: { 'process:-3': 'local:process-creator' } }, 'task-creator', sources, -7)
  expect(captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: -7 } }, sources)).toEqual({ 'process:-3': 'local:task-creator' })
})

it('state creators keep their catalog proof on every observed state including the new negative row', () => {
  const f = fixture(), local: State = { id: -12, code: 'Local', name: 'Local', is_available: false }; f.states.push(local)
  observeDesktopCommand({ route: 'POST /timesheet/states', preconditions: { states: 's' } }, 'state-creator', f.sources, -12)
  f.sources.stateBaseline = { states: 'local:state-creator' }
  expect(local._baseline).toEqual({ states: 's' })
  expect(captureDesktopPreconditions({ route: 'PUT /timesheet/states/{id}', path: { id: -12 } }, f.sources)).toEqual({ states: 'local:state-creator' })
  expect(captureDesktopPreconditions({ route: 'POST /timesheet/states' }, f.sources)).toEqual({ states: 'local:state-creator' })
})

it('an own acknowledgement clears only its accepted pending marker and keeps fresh siblings intact', () => {
  const f = fixture()
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }, 'own-operation', f.sources)
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 }, operationId: 'own-operation' }, { id: 7, process_id: 3, title: 'Confirmed' }, { 'process:3': 'ack' }, f.sources, { 'process:3': 'p3' })
  expect(f.task._baseline).toEqual({ 'process:3': 'ack' }); expect(f.task._pending).toBeUndefined()
  expect(f.task.subtasks![0]!._pending).toEqual({ 'process:3': 'own-operation' })
})

it('an older ACK cannot clear a later observed local operation even when its raw baseline matches', () => {
  const f = fixture(); f.task._baseline = { 'process:3': 'ack-old' }; f.task._pending = { 'process:3': 'newer-operation' }; f.task.title = 'Newer optimism'
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 }, operationId: 'older-operation' }, { id: 7, process_id: 3, title: 'Older confirmed' }, { 'process:3': 'ack-old' }, f.sources, { 'process:3': 'old' })
  expect(f.task.title).toBe('Newer optimism'); expect(f.task._pending).toEqual({ 'process:3': 'newer-operation' })
})

it('the next acknowledgement can consume the captured local predecessor and clear its marker', () => {
  const f = fixture(); f.task._pending = { 'process:3': 'first' }
  acknowledgeDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, { id: 7, process_id: 3, title: 'Next' }, { 'process:3': 'ack-next' }, f.sources, { 'process:3': 'local:first' })
  expect(f.task.title).toBe('Next'); expect(f.task._pending).toBeUndefined(); expect(f.task._baseline).toEqual({ 'process:3': 'ack-next' })
})

it('a pending tag without an actual baseline never manufactures provenance', () => {
  const f = fixture(); delete f.task._baseline; f.task._pending = { 'process:3': 'unbound' }
  expect(() => captureDesktopPreconditions({ route: 'PUT /task/{id}', path: { id: 7 } }, f.sources)).toThrow('COMMAND_BASELINE_REQUIRED')
})

it('unrelated, missing or invalid observations cannot tag loaded source rows', () => {
  const f = fixture(), original = JSON.stringify(f.sources)
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 } }, 'operation', f.sources)
  observeDesktopCommand({ route: 'PUT /task/{id}', path: { id: 7 }, preconditions: { 'process:3': 'p3' } }, '..', f.sources)
  observeDesktopCommand({ route: 'POST /user', preconditions: { 'process:3': 'p3' } }, 'operation', f.sources)
  expect(JSON.stringify(f.sources)).toBe(original)
})
