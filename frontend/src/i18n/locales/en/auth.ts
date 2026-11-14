import type ru from '../ru/auth'
import type { Translation } from '../types'

export default {
  sessionBusy: 'Another tab is renewing the session. Try again in a few seconds.',
  subtitle: 'Project Planning System',
  login: 'Login',
  password: 'Password',
  submit: 'Sign in →',
  submitWaiting: 'Please wait…',
  pingChecking: 'Checking connection…',
  pingOk: 'Server is reachable',
  pingFail: 'Server is unavailable',
  pingCheck: 'Check server connection',
  offlineHint: 'The server cannot verify the password — sign in offline below',
  offlineLogin: 'Sign in offline (no password check)',
  serviceUnavailable: 'Could not open the session. Check your connection and sign in again.',
  noSession: 'No saved session: sign in online at least once',
  fillAll: 'Fill in all fields',
  server: 'Server: {base}',
  settingsLink: '⚙ Server settings',
} satisfies Translation<typeof ru>
