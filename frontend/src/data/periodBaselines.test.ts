import { describe, expect, it } from 'vitest'
import { createPeriodBaselines } from './periodBaselines'
const old = { 'user_days:7': 'old', states: 'states' }
const fresh = { 'user_days:7': 'fresh', states: 'states' }
describe('period snapshot baselines', () => {
  it('keeps metadata even for an empty loaded period window', () => {
    const baselines = createPeriodBaselines()
    baselines.record(7, '2026-01-01', '2026-01-31', old)
    expect(baselines.capture(7, '2026-01-12', '2026-01-15')).toEqual(old)
    expect(baselines.capture(8, '2026-01-12', '2026-01-15')).toBeUndefined()
  })
  it('does not lend a new token from an unrelated loaded range', () => {
    const baselines = createPeriodBaselines()
    baselines.record(7, '2026-01-01', '2026-01-31', old)
    baselines.record(7, '2026-02-01', '2026-02-28', fresh)
    expect(baselines.capture(7, '2026-01-12', '2026-01-15')).toEqual(old)
    expect(baselines.capture(7, '2026-01-30', '2026-02-02')).toBeUndefined()
  })
  it('fails closed for a partially replaced window with a different version', () => {
    const baselines = createPeriodBaselines()
    baselines.record(7, '2026-01-01', '2026-01-31', old)
    baselines.record(7, '2026-01-10', '2026-01-20', fresh)
    expect(baselines.capture(7, '2026-01-12', '2026-01-15')).toBeUndefined()
    baselines.record(7, '2026-01-01', '2026-01-31', fresh)
    expect(baselines.capture(7, '2026-01-12', '2026-01-15')).toEqual(fresh)
  })
  it('clears all account data and never returns mutable internal tokens', () => {
    const baselines = createPeriodBaselines()
    baselines.record(7, '2026-01-01', '2026-01-31', old)
    baselines.capture(7, '2026-01-01', '2026-01-01')!['user_days:7'] = 'changed'
    expect(baselines.capture(7, '2026-01-01', '2026-01-01')).toEqual(old)
    baselines.clear()
    expect(baselines.capture(7, '2026-01-01', '2026-01-01')).toBeUndefined()
  })
})

it('advances only windows proven to share the confirmed request baseline', () => {
  const baselines = createPeriodBaselines()
  baselines.record(7, '2026-01-01', '2026-01-31', old)
  baselines.record(7, '2026-02-01', '2026-02-28', { ...old, 'user_days:7': 'other' })
  baselines.advance(7, old, fresh)
  expect(baselines.capture(7, '2026-01-12', '2026-01-15')).toEqual(fresh)
  expect(baselines.capture(7, '2026-02-12', '2026-02-15')).toEqual({ ...old, 'user_days:7': 'other' })
})

it('preserves causal proof from a batch period row, including an empty day array', async () => {
  const { periodRowBaseline } = await import('./periodBaselines')
  expect(periodRowBaseline({ _baseline: old, _pending: { 'user_days:7': 'observed-period' } })).toEqual({ 'user_days:7': 'local:observed-period', states: 'states' })
  expect(periodRowBaseline({})).toBeUndefined()
})
