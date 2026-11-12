import { defineConfig, loadEnv, type Plugin } from 'vite'
import { rendererPlatformBoundary } from './scripts/platform-boundaries.mjs'
import { readVersion } from './scripts/app-version.cjs'
import vue from '@vitejs/plugin-vue'
import checker from 'vite-plugin-checker'
import { fileURLToPath, URL } from 'node:url'
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'

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
  const appVersion = readVersion()

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
