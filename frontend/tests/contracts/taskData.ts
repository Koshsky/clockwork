import { describe, expect, it } from 'vitest'
import type { DtoTaskPlanning, DtoTaskResponse } from '../../src/api'
import type { DataFailure, TaskDataPort } from '../../src/data/contracts'

export interface TaskDataFixture {
  port: TaskDataPort
  planning(data: DtoTaskPlanning | null): void
  snapshot(data: DtoTaskPlanning | null): void
  updated(data: DtoTaskResponse | null): void
  failRead(status: number, code?: string): void
  failUpdate(status: number, code?: string): void
  offline(): void
  readCount(): number
  queuedCount(): number
  holdRead(): () => void
}

// Each real platform adapter supplies this fixture when it is introduced; running
// mock web/desktop ports here would not establish their contract compliance.
export function taskDataContract(name: string, create: () => TaskDataFixture, capabilities: { offlineWrites: boolean }) {
  describe(`${name}: shared task data contract`, () => {
    it('reads the task hierarchy without exposing an HTTP envelope', async () => {
      const fixture = create()
      const data = { processes: [{ id: 10, tasks: [{ id: 7, title: 'Task', subtasks: [{ id: 8 }] }] }] }
      fixture.planning(data)
      expect(await fixture.port.readPlanning({ source: 'refresh' })).toEqual({ status: 'ok', data, source: 'refresh' })
    })

    it('distinguishes an empty planning result from an unavailable snapshot', async () => {
      const fixture = create()
      fixture.planning({ processes: [] })
      expect(await fixture.port.readPlanning({ source: 'refresh' })).toEqual({ status: 'ok', data: { processes: [] }, source: 'refresh' })
      fixture.snapshot(null)
      expect(await fixture.port.readPlanning({ source: 'snapshot' })).toEqual({ status: 'missing' })
      expect(fixture.readCount()).toBe(1)
    })

    it('does not start a read after cancellation', async () => {
      const fixture = create()
      const controller = new AbortController()
      controller.abort()
      expect(await fixture.port.readPlanning({ source: 'refresh', signal: controller.signal })).toEqual({ status: 'cancelled' })
      expect(fixture.readCount()).toBe(0)
    })

    it('does not return data from a read cancelled during delivery', async () => {
      const fixture = create()
      const release = fixture.holdRead()
      const controller = new AbortController()
      const pending = fixture.port.readPlanning({ source: 'refresh', signal: controller.signal })
      controller.abort()
      release()
      expect(await pending).toEqual({ status: 'cancelled' })
    })

    const failures: Array<[number, string, DataFailure['kind']]> = [
      [400, 'BAD_REQUEST', 'validation'], [401, 'UNAUTHORIZED', 'unauthenticated'],
      [403, 'FORBIDDEN', 'forbidden'], [404, 'NOT_FOUND', 'not-found'],
      [409, 'CONFLICT', 'conflict'], [422, 'VALIDATION_ERROR', 'validation'],
      [429, 'TOO_MANY_REQUESTS', 'unavailable'], [503, 'INTERNAL_ERROR', 'unavailable'],
    ]
    it.each(failures)('preserves read failure semantics for %s/%s', async (status, code, kind) => {
      const fixture = create()
      fixture.failRead(status, code)
      expect(await fixture.port.readPlanning({ source: 'refresh' })).toMatchObject({ status: 'failed', error: { kind, code } })
    })

    it.each(failures)('preserves command failure semantics for %s/%s', async (status, code, kind) => {
      const fixture = create()
      fixture.failUpdate(status, code)
      const result = await fixture.port.update(7, { title: 'Changed' })
      expect(result).toMatchObject({
        status: kind === 'unavailable' ? 'unknown' : kind === 'conflict' ? 'conflict' : 'rejected',
        error: { kind, code },
      })
      expect(fixture.queuedCount()).toBe(0)
    })

    it('returns the server DTO only after a confirmed change', async () => {
      const fixture = create()
      fixture.updated({ id: 7, title: 'Canonical title' })
      expect(await fixture.port.update(7, { title: 'Draft' })).toEqual({ status: 'confirmed', data: { id: 7, title: 'Canonical title' } })
      expect(fixture.queuedCount()).toBe(0)
    })

    it('allows a successful command with no returned entity', async () => {
      const fixture = create()
      fixture.updated(null)
      expect(await fixture.port.update(7, { color: '#123456' })).toEqual({ status: 'confirmed', data: null })
    })

    it('does not report an offline command as confirmed by the server', async () => {
      const fixture = create()
      fixture.offline()
      const result = await fixture.port.update(7, { title: 'Offline' })
      expect(result.status).toBe(capabilities.offlineWrites ? 'queued' : 'unknown')
      expect(fixture.queuedCount()).toBe(capabilities.offlineWrites ? 1 : 0)
    })
  })
}
