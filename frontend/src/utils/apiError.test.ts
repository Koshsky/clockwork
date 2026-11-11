/**
 * Error-message priority of the { data, error } envelope: a specific backend
 * message (already localized — the client sends Accept-Language) wins over the
 * generic text of the code; technical codes keep their generic local text.
 */
import { afterAll, describe, expect, it } from 'vitest'

import { setAppLocale } from '@/i18n'
import { apiErrorMessage, errorTextByCode } from './apiError'

afterAll(() => setAppLocale('ru'))

describe('apiErrorMessage', () => {
  it('prefers a specific backend message over the generic code text', () => {
    setAppLocale('ru')
    expect(apiErrorMessage({ code: 'VALIDATION_ERROR', message: 'пароль слишком простой' })).toBe(
      'пароль слишком простой',
    )
  })

  it('keeps the generic local text for technical codes', () => {
    setAppLocale('ru')
    expect(apiErrorMessage({ code: 'INTERNAL_ERROR', message: 'internal server error' })).toBe(
      'Внутренняя ошибка сервера',
    )
    expect(apiErrorMessage({ code: 'UNAUTHORIZED', message: 'unauthorized' })).toBe('Требуется авторизация')
  })

  it('falls back to the code text when the server message is missing', () => {
    setAppLocale('ru')
    expect(apiErrorMessage({ code: 'NOT_FOUND' })).toBe('Объект не найден')
    expect(apiErrorMessage({ code: 'WEIRD_CODE', message: 'что-то пошло не так' })).toBe('что-то пошло не так')
  })

  it('falls back to the caller text and then to the generic failure', () => {
    setAppLocale('ru')
    expect(apiErrorMessage({}, 'моя ошибка')).toBe('моя ошибка')
    expect(apiErrorMessage(null)).toBe('Ошибка запроса')
  })

  it('follows the interface language', () => {
    setAppLocale('en')
    expect(apiErrorMessage({ code: 'INTERNAL_ERROR', message: 'internal server error' })).toBe(
      'Internal server error',
    )
    expect(apiErrorMessage(null)).toBe('Request failed')
    expect(errorTextByCode('FORBIDDEN')).toBe('Insufficient permissions')
    expect(errorTextByCode('UNKNOWN')).toBeNull()
    setAppLocale('ru')
  })
})
