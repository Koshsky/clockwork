'use strict'

const { app, BrowserWindow, ipcMain, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Never touch an installed application's profile during source-level tests.
if (!process.env.ERP_CSP_USER_DATA) throw new Error('An isolated test profile is required')
app.setPath('userData', process.env.ERP_CSP_USER_DATA)
app.whenReady().then(() => {
  globalThis.cspDownloads = []
  session.defaultSession.on('will-download', (_, item) => {
    const directory = path.join(process.env.ERP_CSP_USER_DATA, 'downloads')
    fs.mkdirSync(directory, { recursive: true })
    const destination = path.join(directory, path.basename(item.getFilename()))
    item.setSavePath(destination)
    item.once('done', (_, state) => globalThis.cspDownloads.push({ path: destination, state }))
  })
  ipcMain.handle('erp:app-version', () => ({ version: '1.6.1', electron: process.versions.electron }))
  const win = new BrowserWindow({
    width: 1440,
    height: 1030,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../desktop/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })
  void win.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
