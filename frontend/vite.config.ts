import { defineConfig, loadEnv, type Plugin } from 'vite'
import { rendererPlatformBoundary } from './scripts/platform-boundaries.mjs'
import vue from '@vitejs/plugin-vue'
import checker from 'vite-plugin-checker'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { execSync } from 'node:child_process'

/**
 * Build version: when the APP_VERSION env var is set (the desktop build script
 * passes the version from desktop/package.json) it is used — the UI ("App version"
 * on the SyncPage) then matches the artifact version. Without env — short git hash +
 * build time (a unique version for every release, as before).
 */
function buildVersion(root: string): string {
  const injected = process.env.APP_VERSION?.trim()
  if (injected) return injected
  let hash = 'dev'
  try {
    hash = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() || 'dev'
  } catch {
    // outside a git repository — stay on 'dev'
  }
  return `${hash}-${Date.now().toString(36)}`
}

/**
 * Writes dist/precache-manifest.json: { version, assets }. The file is used
 * by the app: the build version in the profile UI and server availability
 * checks (outbox/state). There is no Service Worker (not used), so
 * precache-manifest is just a version source, not a list for the SW.
 */
function versionManifest(version: string): Plugin {
  let root = process.cwd()
  let outDir = 'dist'
  return {
    name: 'version-manifest',
    apply: 'build',
    configResolved(config) {
      root = config.root
      outDir = config.build.outDir
    },
    closeBundle() {
      const assetsDir = resolve(root, outDir, 'assets')
      let assets: string[] = []
      try {
        assets = readdirSync(assetsDir)
          .filter((f) => !f.endsWith('.map') && /\.(js|mjs|css|ttf|woff2?|svg|png)$/.test(f))
          .map((f) => `/assets/${f}`)
          .sort()
      } catch {
        // no assets directory (empty build) — keep the list empty
      }
      const dest = resolve(root, outDir, 'precache-manifest.json')
      const payload = { version, assets }
      // The outDir may not exist yet (clean builds — dist is git-/docker-ignored);
      // create it before writing the manifest.
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, `${JSON.stringify(payload, null, 2)}\n`)
    },
  }
}

export default defineConfig(({ mode }) => {
  // Load environment variables from .env (VITE_* etc.)
  const envDir = fileURLToPath(new URL('../', import.meta.url))
  const env = loadEnv(mode, envDir, '')

  // Backend address for the dev proxy (default http://localhost:8080)
  const apiTarget = env.VITE_API_PROXY_TARGET || 'http://localhost:8080'

  // The build version is computed ONCE: it must be identical both in the bundle
  // (__APP_VERSION__) and in precache-manifest.json, otherwise version comparison
  // in the profile would always show "different" builds.
  const appVersion = buildVersion(process.cwd())

  return {
  envDir,
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  plugins: [
    rendererPlatformBoundary(),
    vue(),
    checker({
      vueTsc: true,
      typescript: true,
    }),
    versionManifest(appVersion),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
          target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  }
})
