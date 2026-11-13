'use strict'

const { app, BrowserWindow, ipcMain, session, net, safeStorage } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

// Never touch an installed application's profile during source-level tests.
if (!process.env.ERP_CSP_USER_DATA) throw new Error('An isolated test profile is required')
app.setPath('userData', process.env.ERP_CSP_USER_DATA)
app.whenReady().then(async () => {
  globalThis.cspDownloads = []
  globalThis.sessionWireMetadata = []
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    if (new URL(details.url).pathname.includes('/auth/')) globalThis.sessionWireMetadata.push({ path: new URL(details.url).pathname, origin: details.requestHeaders.Origin, site: details.requestHeaders['Sec-Fetch-Site'] })
    callback({ requestHeaders: details.requestHeaders })
  })
  session.defaultSession.on('will-download', (_, item) => {
    const directory = path.join(process.env.ERP_CSP_USER_DATA, 'downloads')
    fs.mkdirSync(directory, { recursive: true })
    const destination = path.join(directory, path.basename(item.getFilename()))
    item.setSavePath(destination)
    item.once('done', (_, state) => globalThis.cspDownloads.push({ path: destination, state }))
  })
  const { createSessionVault } = require('../desktop/session-vault.cjs')
  const { createSessionService } = require('../desktop/session-service.cjs')
  const { createDesktopService } = require('../desktop/service.cjs')
  const { createDesktopIpc } = require('../desktop/ipc.cjs')
  const vault = createSessionVault(app.getPath('userData'), safeStorage)
  await vault.load()
  const { createStorage } = require('../desktop/storage.cjs')
  const storage = await createStorage({ directory: app.getPath('userData') })
  const service = createDesktopService({ storage, profileId: 'isolated-test', version: '1.6.3', electron: process.versions.electron })
  let queue
  const auth = createSessionService({ vault, interceptApi: (request, send) => queue.api(request, send), fetch: (url, options) => globalThis.sessionFetchOverride ? globalThis.sessionFetchOverride(url, options, net.fetch.bind(net)) : net.fetch(url, options), onIdentity: state => service.setScope(state.user && state.mode !== 'signedOut' ? { server: state.server, accountId: state.user.id } : null) })
  queue = require('../desktop/command-queue.cjs').createCommandQueue({ storage, session: auth })
  service.installQueue(queue)
  service.installAdapters(require('../desktop/business-adapters.cjs').createBusinessAdapters({ session: auth, queue }))
  const sync = require('../desktop/sync-service.cjs').createSyncService({ storage, session: auth, queue })
  service.installSync(sync)
  service.start()
  globalThis.syncFixture = sync
  globalThis.commandQueueFixture = queue
  globalThis.sessionFixture = auth
  const bridge = createDesktopIpc({ ipcMain, service, session: auth, queue, origin: new URL(process.env.ERP_TEST_URL || process.env.NAV_TEST_WEB_URL || 'http://127.0.0.1:5173').origin })
  let stopping = false
  app.on('before-quit', event => {
    if (stopping) return
    event.preventDefault(); stopping = true; auth.stop()
    void service.stop().finally(async () => { await storage.close(); bridge.dispose(); app.quit() })
  })
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
  bridge.attach(win.webContents)
  globalThis.attachSessionFixture = contents => bridge.attach(contents)
  void win.loadURL('about:blank')
})
app.on('window-all-closed', () => app.quit())
