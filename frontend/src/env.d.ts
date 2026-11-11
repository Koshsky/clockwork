/// <reference types="vite/client" />

/** Version of the running bundle (injected at build time via define) */
declare const __APP_VERSION__: string

interface ImportMetaEnv {
  /** Base API URL (default /api/v1) */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- vue shim: component instances are opaque here
  const component: DefineComponent<object, object, any>
  export default component
}

/** pdf.js worker imported on the main thread (fake worker) for polyfills */
declare module 'pdfjs-dist/build/pdf.worker.min.mjs' {
  const workerModule: unknown
  export default workerModule
}

/**
 * Electron bridge injected by preload (services/desktop/preload.js).
 * Absent in the browser — the app keeps working as a regular PWA.
 */
interface ErpDesktop {
  isElectron: true
  appVersion: () => Promise<{ version: string; electron: string }>
}

interface Window {
  erpDesktop?: ErpDesktop
}

