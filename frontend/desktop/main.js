'use strict'

/**
 * Electron main process for MVS ERP.
 *
 * The app serves the built vite frontend (services/frontend/dist) through a
 * local HTTP server on 127.0.0.1, not via file://. Reason: the frontend
 * hard-codes root paths (/precache-manifest.json, /assets/*),
 * designed for an http context.
 * The local http server keeps them working without changing the frontend.
 *
 * The API is external: the user sets the backend URL on the sync screen
 * (the frontend's runtime configuration). Sessions are restored from the
 * refresh token stored by the renderer (IndexedDB) — no credentials are
 * kept in the main process.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const { createStaticHandler } = require('./static-server.cjs')

// ---------------------------------------------------------------------------
// Shell copy (RU/EN). The renderer follows the interface-language setting, but
// this dialog is raised before any window exists, so the desktop shell follows
// the OS locale (Russian is the product default).
// ---------------------------------------------------------------------------
const SHELL_TEXT = {
  ru: {
    errorTitle: 'MVS ERP — ошибка запуска',
    startFailed: (detail) => `Не удалось запустить локальный сервер приложения: ${detail}`,
  },
  en: {
    errorTitle: 'MVS ERP — startup error',
    startFailed: (detail) => `Failed to start the local application server: ${detail}`,
  },
}

function shellText() {
  const locale = String(app.getLocale() || 'ru').toLowerCase()
  return locale.startsWith('en') ? SHELL_TEXT.en : SHELL_TEXT.ru
}

// ---------------------------------------------------------------------------
// User data location — deterministic per-user folder on every platform.
// ---------------------------------------------------------------------------
// Pin the directory name explicitly so it never depends on productName and
// never falls back to a temporary location:
//   Linux   ~/.config/mvs-erp-desktop            (XDG_CONFIG_HOME-aware)
//   Windows %APPDATA%\mvs-erp-desktop
//   macOS   ~/Library/Application Support/mvs-erp-desktop
// The Linux path matches the existing profile (session, cache, offline queue
// and the singleton lock are NOT lost). Must be set before any
// app.getPath('userData') call (singleton lock below) and before app ready.
//
// A CLI --user-data-dir override is honored (not overwritten): testing /
// diagnostic launches use it on purpose and must keep working — otherwise the
// app would silently keep the old profile data and never show the login page.
const usesCliUserDataDir = process.argv.some(
  (arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='),
)
if (!usesCliUserDataDir) {
  app.setPath('userData', path.join(app.getPath('appData'), 'mvs-erp-desktop'))
}

const DEFAULT_PORT = 31880
/** How many consecutive ports to try after DEFAULT_PORT when it is busy */
const PORT_SEARCH_LIMIT = 20
/**
 * Path to the built frontend.
 *  - dev (electron .): desktop/../dist = services/frontend/dist
 *  - packaged: extraResources places dist into <resources>/web (outside app.asar)
 */
const WEB_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'web')
  : path.join(__dirname, '..', 'dist')

// Single instance: two windows (and two local HTTP servers on the same port)
// must never run at once. A second launch focuses the existing window instead
// of ending up with a blank/broken second instance.
//
// requestSingleInstanceLock() returns false BOTH when another instance owns the
// lock AND when the lock cannot be created at all (read-only HOME, unusual
// environments). So we only quit when the lock file really exists — otherwise
// we run anyway (the dynamic port fallback below covers duplicate instances).
const gotTheLock = app.requestSingleInstanceLock()
const lockFile = path.join(app.getPath('userData'), 'SingletonLock')
if (!gotTheLock && fs.existsSync(lockFile)) {
  console.log('[desktop] the app is already running — quitting (single instance)')
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })
}

// ---------------------------------------------------------------------------
// Local http server for the built frontend
// ---------------------------------------------------------------------------

const serveStatic = createStaticHandler(WEB_DIR)

/**
 * Starts the local HTTP server for the built frontend.
 *
 * The default port may already be taken (a leftover instance that crashed, or
 * another app). We then fall back to the next free ports (up to
 * PORT_SEARCH_LIMIT tries). If no port is free — reject; the caller shows an
 * error dialog instead of silently leaving the user with a blank window.
 */
async function startHttpServer() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + PORT_SEARCH_LIMIT; port++) {
    try {
      return await listenOnce(port)
    } catch (err) {
      // Only a busy port is retried; anything else (permissions, etc.) is fatal.
      if (err.code !== 'EADDRINUSE') throw err
      console.log(`[desktop] port ${port} is busy — trying the next one`)
    }
  }
  throw new Error(`No free port in the range ${DEFAULT_PORT}-${DEFAULT_PORT + PORT_SEARCH_LIMIT - 1}`)
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(serveStatic)
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const { port: boundPort } = server.address()
      console.log(`[desktop] local frontend http server: http://127.0.0.1:${boundPort}`)
      resolve(server)
    })
  })
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow(baseUrl) {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f4f6f9',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.loadURL(baseUrl)
  return win
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

let server = null

/**
 * Allow self-signed TLS certificates of the backend (nginx generates
 * server.crt via generate-certs.sh). Chromium rejects self-signed
 * by default, so without this https://localhost (and other internal servers)
 * would not work. We accept ONLY self-signed certificates (issuer ==
 * subject); validation for the rest (untrusted chain, wrong domain,
 * expired) is preserved.
 */
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

app.whenReady().then(async () => {
  // Stop startup only when the lock is held by another instance (the lock
  // file exists). If the lock could not be created at all (read-only
  // userData, unusual environments) we run anyway — the dynamic port
  // fallback below covers duplicate instances.
  if (!gotTheLock && fs.existsSync(lockFile)) return

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
  const { session } = require('electron')
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
    server = await startHttpServer()
  } catch (err) {
    // No free port at all (or a fatal bind error): tell the user instead of
    // silently showing nothing / a blank window.
    console.error('[desktop] failed to start the local http server:', err)
    const text = shellText()
    dialog.showErrorBox(text.errorTitle, text.startFailed(err && err.message ? err.message : err))
    app.quit()
    return
  }
  const { port } = server.address()
  const baseUrl = `http://127.0.0.1:${port}`

  ipcMain.handle('erp:app-version', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
  }))

  createWindow(baseUrl)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(baseUrl)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (server) server.close()
})
