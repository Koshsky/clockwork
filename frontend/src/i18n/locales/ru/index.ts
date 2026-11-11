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
 * Russian message catalog — the source of truth and the fallback locale. Keys
 * are the stable identifiers; locales/en carries the translations and is
 * type-checked against this shape. Domains are added wave by wave.
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
