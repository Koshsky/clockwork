import { describe, expect, it } from 'vitest'
import { translitPhio } from './translit'

describe('translitPhio — default login from the full name', () => {
  it('builds surname + initials for a full name (patronymic present)', () => {
    expect(translitPhio('Шмонов', 'Матвей', 'Васильевич')).toBe('shmonov.mv')
  })

  it('builds surname + single initial when there is no patronymic', () => {
    expect(translitPhio('Иванов', 'Пётр')).toBe('ivanov.p')
  })

  it('drops the patronymic when it is an empty string', () => {
    expect(translitPhio('Шмонов', 'Матвей', '')).toBe('shmonov.m')
  })

  it('returns the surname alone when both name parts are unavailable', () => {
    expect(translitPhio('Шмонов', '', '')).toBe('shmonov')
  })

  it('returns an empty string when nothing transliterates (Latin surname)', () => {
    expect(translitPhio('Smith', 'Джон')).toBe('')
    expect(translitPhio('Smith', 'John')).toBe('')
  })
})