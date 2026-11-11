import adminConfig from './adminConfig'
import adminSystem from './adminSystem'
import adminUsers from './adminUsers'
import app from './app'
import auth from './auth'
import authz from './authz'
import changelog from './changelog'
import common from './common'
import dates from './dates'
import errors from './errors'
import header from './header'
import nav from './nav'
import offline from './offline'
import pdf from './pdf'
import planner from './planner'
import plannerViews from './plannerViews'
import timesheet from './timesheet'
import ui from './ui'

/**
 * English message catalog. Keys mirror locales/ru; a missing key falls back to
 * the Russian text (fallbackLocale in i18n/index.ts), so an untranslated area
 * degrades gracefully instead of showing a key. Every domain file is
 * type-checked against its Russian counterpart.
 */
export default {
  adminConfig,
  adminSystem,
  adminUsers,
  app,
  auth,
  authz,
  changelog,
  common,
  dates,
  errors,
  header,
  nav,
  offline,
  pdf,
  planner,
  plannerViews,
  timesheet,
  ui,
} as const
