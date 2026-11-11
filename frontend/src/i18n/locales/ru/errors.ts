/**
 * Russian catalog — API failures: the machine-readable codes returned by the
 * backend (utils/apiError) plus the generic fallback of a failed request.
 */
export default {
  request: 'Ошибка запроса',
  code: {
    badRequest: 'Некорректный запрос',
    unauthorized: 'Требуется авторизация',
    forbidden: 'Недостаточно прав',
    notFound: 'Объект не найден',
    tooManyRequests: 'Слишком много запросов, повторите позже',
    invalidCredentials: 'Неверный логин или пароль',
    invalidToken: 'Сессия истекла, войдите заново',
    validation: 'Проверьте корректность данных',
    internal: 'Внутренняя ошибка сервера',
  },
} as const
