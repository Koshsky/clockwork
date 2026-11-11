import type ru from '../ru/errors'
import type { Translation } from '../types'

/** English catalog mirroring locales/ru/errors.ts. */
export default {
  request: 'Request failed',
  code: {
    badRequest: 'Invalid request',
    unauthorized: 'Authorization required',
    forbidden: 'Insufficient permissions',
    notFound: 'Object not found',
    tooManyRequests: 'Too many requests, try again later',
    invalidCredentials: 'Invalid login or password',
    invalidToken: 'Session expired, sign in again',
    validation: 'Check the entered data',
    internal: 'Internal server error',
  },
} satisfies Translation<typeof ru>
