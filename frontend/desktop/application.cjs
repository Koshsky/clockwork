'use strict'

const { createStorage } = require('./storage.cjs')
const { createSessionVault } = require('./session-vault.cjs')
const { createSessionService } = require('./session-service.cjs')
const path = require('node:path')
const http = require('node:http')
const { createStaticHandler } = require('./static-server.cjs')
const { loadProfile } = require('./profile.cjs')
const { createDesktopService } = require('./service.cjs')
const { createDesktopIpc } = require('./ipc.cjs')
const { attachRendererRecovery } = require('./renderer-recovery.cjs')

function startDesktop({ app, BrowserWindow, ipcMain, dialog, session, safeStorage, net, powerMonitor }, { webDir, preload = path.join(__dirname, 'preload.js'), basePort = 31880, portAttempts = 20, ports = {}, createPorts }) {
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
  function createWindow() {
    if (!origin || service.status().phase !== 'ready') throw new Error('Desktop service is not ready')
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
      try { if (new URL(url).origin === origin) return } catch { /* Invalid URLs are denied. */ }
      event.preventDefault()
    })
    win.once('closed', () => windows.delete(win))
    win.once('ready-to-show', () => win.show())
    void win.loadURL(origin)
    return win
  }
  app.on('second-instance', () => {
    const win = [...windows][0]
    if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus() }
  })
  app.on('activate', () => { if (service?.status().phase === 'ready' && !windows.size) createWindow() })
  app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
    const isSelfSigned =
      certificate.issuerName === certificate.subjectName &&
      /CN=/.test(certificate.subjectName)
    if (isSelfSigned && /^https:\/\//.test(url)) {
      console.log('[desktop] accepted a self-signed certificate:', url)
      event.preventDefault()
      callback(true)
    } else {
      callback(false)
    }
  })
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
    // setCertificateVerifyProc intercepts ALL TLS session verifications, including
    // fetch/axios from the renderer (for them certificate-error does not always fire).
    // It runs on the presented (unvalidated) certificate chain, so the same policy
    // as the 'certificate-error' handler above must be re-applied here: a failed
    // verification is accepted ONLY when the server presented a genuine self-signed
    // certificate (issuer == subject, subject carries a CN). A certificate forged
    // by a MITM CA has issuer != subject and is rejected — as are expiry and
    // hostname-mismatch errors, which self-signing cannot cure.
    // Codes — Chromium net::Error:
    //   0    — certificate is valid (always accepted);
    //  -202  — ERR_CERT_AUTHORITY_INVALID (self-signed / untrusted CA);
    //  -207  — ERR_CERT_INVALID (invalid, but often self-signed).
    // Expired (-201) and wrong-domain (-200) are rejected regardless of the
    // issuer/subject match, exactly as before.
    session.defaultSession.setCertificateVerifyProc((request, callback) => {
      const isSelfSigned =
        request.certificate.issuerName === request.certificate.subjectName &&
        /CN=/.test(request.certificate.subjectName)
      const isTrustedSelfSigned =
        request.errorCode !== 0 &&
        (request.errorCode === -202 || request.errorCode === -207) &&
        isSelfSigned
      if (request.errorCode !== 0 && !isTrustedSelfSigned) {
        console.log('[desktop] certificate rejected:', request.hostname, 'code=', request.errorCode)
      }
      if (request.errorCode === 0 || isTrustedSelfSigned) {
        callback(0)
      } else {
        callback(-3)
      }
    })

    try {
      const profileId = await loadProfile(app.getPath('userData'))
      storage = await createStorage({ directory: app.getPath('userData') })
      const adapters = createPorts ? await createPorts({ storage }) : ports
      service = createDesktopService({ profileId, version: app.getVersion(), electron: process.versions.electron, ...adapters, storage })
      server = await startServer()
      origin = `http://127.0.0.1:${server.address().port}`
      if (safeStorage && net) {
        const vault = createSessionVault(app.getPath('userData'), safeStorage)
        await vault.load()
        auth = createSessionService({ vault, fetch: (url, options) => net.fetch(url, options), onIdentity: state => service.setScope(state.user && state.mode !== 'signedOut' ? { server: state.server, accountId: state.user.id } : null) })
        authTimer = setInterval(() => { void auth.tick().catch(() => {}) }, 30000)
        resumeAuth = () => { void auth.tick().catch(() => {}) }
        powerMonitor?.on('resume', resumeAuth)
      }
      ipc = createDesktopIpc({ ipcMain, service, origin, session: auth })
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
