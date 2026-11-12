'use strict'

const electron = require('electron')
const path = require('node:path')
const { startDesktop } = require('./application.cjs')
const { app } = electron

// Keep the installed profile identity and honor explicit diagnostic profiles.
const usesCliUserDataDir = process.argv.some(
  (arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
)
if (!usesCliUserDataDir) {
  app.setPath('userData', path.join(app.getPath('appData'), 'mvs-erp-desktop'))
}

const webDir = app.isPackaged ? path.join(process.resourcesPath, 'web') : path.join(__dirname, '..', 'dist')
startDesktop(electron, { webDir })
