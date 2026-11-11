import { describe, expect, it } from 'vitest'
import { presetDescriptionByTag, presetDisplayName, presetLabelFromCatalog } from './presets'

describe('preset display helpers', () => {
  it('uses the human-readable name first', () => {
    expect(presetDisplayName({ tag: 'auditor', name: 'Внешний аудит' })).toBe('Внешний аудит')
    expect(presetDisplayName({ tag: 'dp', name: 'Директор проектов' })).toBe('Директор проектов')
  })

  it('falls back to the built-in label by tag', () => {
    expect(presetDisplayName({ tag: 'worker', name: '' })).toBe('Работник')
    expect(presetDisplayName({ tag: 'admin' })).toBe('Администратор')
  })

  it('falls back to the raw tag for unknown tags', () => {
    expect(presetDisplayName({ tag: 'custom-x' })).toBe('custom-x')
  })

  it('renders a dash when nothing is known', () => {
    expect(presetDisplayName({})).toBe('—')
    expect(presetDisplayName({ tag: '', name: '  ' })).toBe('—')
  })

  it('resolves a user-referenced tag through the catalog', () => {
    const catalog = [
      { tag: 'dp', name: 'Директор проектов' },
      { tag: 'auditor', name: 'Внешний аудит' },
    ]
    expect(presetLabelFromCatalog('dp', catalog)).toBe('Директор проектов')
    expect(presetLabelFromCatalog('auditor', catalog)).toBe('Внешний аудит')
    expect(presetLabelFromCatalog('worker', catalog)).toBe('Работник')
    expect(presetLabelFromCatalog('custom', catalog)).toBe('custom')
    expect(presetLabelFromCatalog(null, catalog)).toBe('—')
  })

  it('returns the description by tag', () => {
    const catalog = [
      { tag: 'auditor', name: 'Внешний аудит', description: 'Проверка годовой отчётности' },
      { tag: 'dp', name: 'Директор проектов', description: '  ' },
    ]
    expect(presetDescriptionByTag('auditor', catalog)).toBe('Проверка годовой отчётности')
    expect(presetDescriptionByTag('dp', catalog)).toBe('')
    expect(presetDescriptionByTag('worker', catalog)).toBe('')
    expect(presetDescriptionByTag(null, catalog)).toBe('')
  })
})