'use strict'

/**
 * Preload: bridge between the renderer and main via contextBridge.
 * The renderer receives a minimal, strictly typed API:
 *   window.erpDesktop.isElectron  → true
 *   window.erpDesktop.appVersion  → { version, electron }
 *
 * The renderer has no access to Node/filesystem (nodeIntegration off,
 * contextIsolation on, sandbox on).
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('erpDesktop', {
  isElectron: true,
  appVersion: () => ipcRenderer.invoke('erp:app-version'),
})
