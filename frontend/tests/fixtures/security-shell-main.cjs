'use strict'
const electron = require('electron')
if (!process.env.ERP_SECURITY_PROFILE || !process.env.ERP_SECURITY_WEB_DIR) throw new Error('An isolated security fixture is required')
electron.app.setName('clockwork-security-fixture')
electron.app.setPath('userData', process.env.ERP_SECURITY_PROFILE)
globalThis.securityExternalLinks = []
const shell = { openExternal: async url => { globalThis.securityExternalLinks.push(url) } }
const { startDesktop } = require('../../desktop/application.cjs')
globalThis.securityApplication = startDesktop({ ...electron, shell }, { webDir: process.env.ERP_SECURITY_WEB_DIR, basePort: 0, portAttempts: 1 })
