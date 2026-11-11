import { describe, expect, it } from 'vitest'
import { usePlanningOrigin } from './usePlanningOrigin'

describe('planning unit across page mounts', () => {
  it('keeps the chosen unit across projects, processes, tasks and back', () => {
    const projects = usePlanningOrigin()
    const initial = projects.unit.value
    try {
      projects.unit.value = 'week'
      const processes = usePlanningOrigin()
      expect(processes.unit.value).toBe('week')
      const tasks = usePlanningOrigin()
      expect(tasks.unit.value).toBe('week')
      expect(usePlanningOrigin().unit.value).toBe('week')
      tasks.unit.value = 'day'
      expect(usePlanningOrigin().unit.value).toBe('day')
      expect(projects.unit.value).toBe('day')
    } finally {
      projects.unit.value = initial
    }
  })
})
