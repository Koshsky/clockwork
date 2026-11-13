import { expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  app: { resourceMembers: {} as Record<number, unknown[]>, resources: Array.from({ length: 60 }, (_, id) => ({ id: id + 1 })), refreshResourceMembers: vi.fn() },
}))
vi.mock('@/store', () => ({ useAppStore: () => fixture.app, usePlanningStore: () => ({}), useTimesheetStore: () => ({}) }))
import { nativeSnapshotReloaders } from './nativeHydration'

it('refreshes only member lists actually loaded by the UI rather than all resource pages', async () => {
  const refresh = nativeSnapshotReloaders().find(row => row.name === 'members')!.run
  await refresh()
  expect(fixture.app.refreshResourceMembers).not.toHaveBeenCalled()
  fixture.app.resourceMembers[1] = []; fixture.app.resourceMembers[60] = []
  await refresh()
  expect(fixture.app.refreshResourceMembers.mock.calls).toEqual([[1, true], [60, true]])
  fixture.app.refreshResourceMembers.mockClear(); delete fixture.app.resourceMembers[1]
  await refresh()
  expect(fixture.app.refreshResourceMembers.mock.calls).toEqual([[60, true]])
})
