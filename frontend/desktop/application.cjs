'use strict'

const { createBusinessAdapters } = require('./business-adapters.cjs')
const { createSyncService } = require('./sync-service.cjs')
const { createCommandQueue } = require('./command-queue.cjs')
const { createStorage } = require('./storage.cjs')
const { createSessionVault } = require('./session-vault.cjs')
const { createSessionService } = require('./session-service.cjs')
const path = require('node:path')
const http = require('node:http')
const { isApplicationDocument, isWebUrl } = require('./security.cjs')
const { createStaticHandler } = require('./static-server.cjs')
const { loadProfile } = require('./profile.cjs')
const { createDesktopService } = require('./service.cjs')
const { createDesktopIpc } = require('./ipc.cjs')
const { attachRendererRecovery } = require('./renderer-recovery.cjs')

function startDesktop({ app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, powerMonitor }, { webDir, preload = path.join(__dirname, 'preload.js'), basePort = 31880, portAttempts = 20, ports = {}, createPorts }) {
  // Shell dialogs can precede the renderer, so their copy follows the OS locale.
  const SHELL_TEXT = {
    ru: {
      errorTitle: 'MVS ERP — ошибка запуска',
      recoveryFailed: 'Не удалось восстановить окно приложения. Перезапустите приложение.',
      startFailed: (detail) => `Не удалось запустить приложение: ${detail}`,
    },
    en: {
      errorTitle: 'MVS ERP — startup error',
      recoveryFailed: 'The application window could not be restored. Restart the application.',
      startFailed: (detail) => `Failed to start the application: ${detail}`,
    },
  }

  function shellText() {
    const locale = String(app.getLocale() || 'ru').toLowerCase()
    return locale.startsWith('en') ? SHELL_TEXT.en : SHELL_TEXT.ru
  }
  // A failed lock never authorizes a second owner, including read-only profiles.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return { ready: Promise.resolve(null) }
  }
  let server = null, service = null, ipc = null, quitting = false, shutdown = null
  let storage = null
  let auth = null, authTimer = null, resumeAuth = null
  const windows = new Set()
  let origin = null
  function createWindow(target = origin) {
    if (!isApplicationDocument(target, origin) || service.status().phase !== 'ready') throw new Error('Desktop service is not ready')
    const win = new BrowserWindow({
      width: 1440, height: 900, minWidth: 1024, minHeight: 640,
      show: false, autoHideMenuBar: true, backgroundColor: '#f4f6f9',
      webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    windows.add(win)
    ipc.attach(win.webContents)
    attachRendererRecovery(win.webContents, {
      origin, active: () => service.status().phase === 'ready',
      onFailed: () => { const copy = shellText(); dialog.showErrorBox(copy.errorTitle, copy.recoveryFailed) },
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (isApplicationDocument(url, origin)) return
      event.preventDefault()
    })
    let linkGestureAt = -Infinity
    win.webContents.on('before-mouse-event', (_, input) => {
      if (input.type === 'mouseUp' && ['left', 'middle'].includes(input.button)) linkGestureAt = performance.now()
    })
    win.webContents.on('before-input-event', (_, input) => {
      if (input.type === 'keyDown' && input.key === 'Enter') linkGestureAt = performance.now()
    })
    win.webContents.setWindowOpenHandler(details => {
      // A page script cannot turn a timer or a forged DOM click into an OS launch.
      const gesture = performance.now() - linkGestureAt <= 1000
      linkGestureAt = -Infinity
      if (gesture && !details.postBody && isApplicationDocument(win.webContents.getURL(), origin)) {
        if (isApplicationDocument(details.url, origin)) {
          createWindow(details.url)
        } else if (isWebUrl(details.url)) void shell?.openExternal(details.url).catch(() => {})
      }
      return { action: 'deny' }
    })
    win.once('closed', () => windows.delete(win))
    win.once('ready-to-show', () => win.show())
    void win.loadURL(target)
    return win
  }
  app.on('second-instance', () => {
    const win = [...windows][0]
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })
  app.on('activate', () => { if (service?.status().phase === 'ready' && !windows.size) createWindow() })
  async function listen(port) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer(createStaticHandler(webDir))
      candidate.once('error', reject)
      candidate.listen(port, '127.0.0.1', () => resolve(candidate))
    })
  }
  async function startServer() {
    for (let offset = 0; offset < portAttempts; offset++) {
      try { return await listen(basePort === 0 ? 0 : basePort + offset) }
      catch (error) { if (error.code !== 'EADDRINUSE') throw error }
    }
    throw new Error('No free local application port')
  }
  const ready = app.whenReady().then(async () => {
    // Backend credentials require normal Chromium/OS certificate verification.
    // Private deployments can trust their CA in the OS store, never a blanket bypass.
    try {
      const profileId = await loadProfile(app.getPath('userData'))
      storage = await createStorage({ directory: app.getPath('userData') })
      const adapters = createPorts ? await createPorts({ storage }) : ports
      const version = app.isPackaged ? app.getVersion() : require('../package.json').version
      service = createDesktopService({ profileId, version, electron: process.versions.electron, ...adapters, storage })
      server = await startServer()
      origin = `http://127.0.0.1:${server.address().port}`
      let commandQueue
      if (safeStorage && net) {
        const vault = createSessionVault(app.getPath('userData'), safeStorage)
        await vault.load()
        auth = createSessionService({ vault, interceptApi: (request, send) => commandQueue.api(request, send), fetch: (url, options) => net.fetch(url, options), onIdentity: state => service.setScope(state.user && state.mode !== 'signedOut' ? { server: state.server, accountId: state.user.id } : null) })
        commandQueue = createCommandQueue({ storage, session: auth })
        service.installQueue(commandQueue)
        service.installAdapters(createBusinessAdapters({ session: auth, queue: commandQueue }))
        service.installSync(createSyncService({ storage, session: auth, queue: commandQueue, powerMonitor }))
        authTimer = setInterval(() => { void auth.tick().catch(() => {}) }, 30000)
        resumeAuth = () => { void auth.tick().catch(() => {}) }
        powerMonitor?.on('resume', resumeAuth)
      }
      ipc = createDesktopIpc({ ipcMain, service, origin, session: auth, queue: commandQueue })
      service.start()
      createWindow()
      return { service, storage, createWindow, origin }
    } catch (error) {
      await storage?.close()
      server?.close()
      const copy = shellText()
      dialog.showErrorBox(copy.errorTitle, copy.startFailed(error instanceof Error ? error.message : String(error)))
      app.quit()
      return null
    }
  })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('before-quit', event => {
    if (!service || quitting) return
    event.preventDefault()
    if (shutdown) return
    if (authTimer) clearInterval(authTimer)
    if (resumeAuth) powerMonitor?.removeListener('resume', resumeAuth)
    auth?.stop()
    shutdown = service.stop().finally(async () => {
      await storage?.close()
      ipc?.dispose()
      server?.close()
      quitting = true
      app.quit()
    })
  })
  app.on('will-quit', () => { ipc?.dispose(); server?.close() })
  return { ready }
}

module.exports = { startDesktop }
