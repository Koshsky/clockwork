import { _electron } from 'playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export async function launchElectronFixture() {
  const profile = mkdtempSync(path.join(tmpdir(), 'erp-csp-electron-'))
  const env = { ...process.env, ERP_CSP_USER_DATA: profile }
  delete env.ELECTRON_RUN_AS_NODE
  let app
  try {
    app = await _electron.launch({
      executablePath: process.env.ELECTRON_EXECUTABLE,
      args: [fileURLToPath(new URL('../electron-main.cjs', import.meta.url))],
      env,
    })
    await app.firstWindow({ timeout: 15000 })
    return { app, close: async () => {
      try { await app.close() } finally { rmSync(profile, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try {
      if (app) await app.close()
    } finally {
      rmSync(profile, { recursive: true, force: true })
    }
    throw error
  }
}
