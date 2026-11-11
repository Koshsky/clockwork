import { describe, expect, it } from 'vitest'
import { shortName } from './shortName'

describe('Gantt badge names', () => {
  it('uses structured fields before the display name', () => {
    expect(shortName({ last_name: 'Иванов', first_name: 'Пётр', middle_name: 'Сергеевич', name: 'Other Name' })).toBe('Иванов П.С.')
  })
  it('omits the patronymic initial when no patronymic is set', () => {
    expect(shortName({ last_name: 'Иванов', first_name: 'Пётр' })).toBe('Иванов П.')
  })
  it.each([
    [{ last_name: 'Иванов' }, 'Иванов'],
    [{ last_name: 'Иванов', first_name: null, middle_name: 'Иванович' }, 'Иванов И.'],
    [{ last_name: 'Иванов', first_name: '', middle_name: null }, 'Иванов'],
    [{ last_name: '  Иванов ', first_name: ' Пётр ', middle_name: '  ' }, 'Иванов П.'],
    [{ first_name: 'Пётр', middle_name: 'Сергеевич' }, 'П.С.'],
    [{ middle_name: 'Сергеевич' }, 'С.'],
    [{ last_name: '', first_name: '', middle_name: '' }, ''],
    [{ last_name: null, first_name: null, middle_name: null }, ''],
    [{ last_name: 'Иванов', first_name: 'И.', middle_name: '.' }, 'Иванов И.'],
    [undefined, ''],
  ])('formats missing or empty name parts without extra punctuation: %j', (user, expected) => {
    expect(shortName(user)).toBe(expected)
  })

  it('keeps existing initials in fallback display names', () => {
    expect(shortName({ name: 'Иванов И.И.' })).toBe('Иванов И.И.')
    expect(shortName({ name: 'Иванов Иван Иванович' })).toBe('Иванов И.И.')
  })
})
