'use strict'
const electron = require('electron')
const path = require('node:path')
if (process.env.ERP_TEST_ISOLATED !== '1' || !process.env.ERP_ARTIFACT_PROFILE) throw new Error('An isolated artifact test profile is required')
electron.app.setPath('userData', process.env.ERP_ARTIFACT_PROFILE)
electron.app.commandLine.appendSwitch('force-color-profile', 'srgb')
electron.app.commandLine.appendSwitch('force-device-scale-factor', '1')
// The stock runtime otherwise treats an ASAR argument as an unpackaged development app.
Object.defineProperty(electron.app, 'isPackaged', { value: true })
// The fixture is copied into the test ASAR beside the actual production modules.
const { startDesktop } = require('./application.cjs')
const dialog = { ...electron.dialog, showErrorBox: (title, detail) => { console.error(title, detail) } }
void startDesktop({ ...electron, dialog }, { webDir: path.join(__dirname, 'web'), basePort: 0 }).ready.then(host => {
  if (!host) throw new Error('Artifact service did not start')
  globalThis.artifactFixture = host
}).catch(error => { console.error(error); electron.app.exit(1) })
