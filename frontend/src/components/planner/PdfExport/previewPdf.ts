/**
 * Preview of the generated PDF: pages are drawn on canvas via pdf.js
 * and stacked into the container. pdf.js and its modules are lazy-loaded (only on
 * the first preview render) so they are not pulled into the main chunk.
 *
 * Uses pdfjs-dist v4 (pinned to an exact version): v5+ requires
 * Map.prototype.getOrInsertComputed (ES2025), which old browsers lack.
 *
 * Rendering runs WITHOUT a worker (pdf.js fake worker — on the main thread):
 * a separate Worker has its own global scope where our polyfills do not apply,
 * and when the browser lacks modern APIs the worker crashes with an uncaught
 * exception — loadingTask.promise never resolves, so the preview hangs forever
 * ("Preparing preview…"). On the main thread all polyfills work, so rendering
 * is guaranteed to complete.
 */

import { t } from '@/i18n'

/** Timeout for the whole preview render — protection against an "endless" spinner */
const RENDER_TIMEOUT_MS = 20000

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null
let workerReady = false

/**
 * Promise.withResolvers polyfill for browsers where pdf.js v4 does not yet
 * encounter it (Chrome <119, Firefox <121). No-op if the method already exists.
 */
function ensurePromiseWithResolvers() {
  const P = Promise as unknown as {
    withResolvers?: <T>() => { promise: Promise<T>; resolve: (v: T | PromiseLike<T>) => void; reject: (e?: unknown) => void }
  }
  if (!P.withResolvers) {
    P.withResolvers = <T>() => {
      let resolve!: (v: T | PromiseLike<T>) => void
      let reject!: (e?: unknown) => void
      const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
      })
      return { promise, resolve, reject }
    }
  }
}

/**
 * Lazily loads pdf.js and enables main-thread rendering (fake worker):
 * importing the worker module on the main thread sets globalThis.pdfjsWorker,
 * after which PDFWorker._initialize() takes the _setupFakeWorker() path and no
 * Worker is created at all.
 */
function loadPdfjs(): Promise<typeof import('pdfjs-dist')> {
  if (!pdfjsPromise) {
    ensurePromiseWithResolvers()
    pdfjsPromise = (async () => {
      const mod = await import('pdfjs-dist')
      try {
        const g = globalThis as { pdfjsWorker?: unknown }
        if (!g.pdfjsWorker) {
          // The worker module (webpack build) on main-thread import itself
          // executes: __webpack_exports__ = globalThis.pdfjsWorker = {...}
          await import('pdfjs-dist/build/pdf.worker.min.mjs')
        }
      } catch {
        // Could not attach the fake worker — fall back to the regular worker
      }
      if (!workerReady) {
        const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url')
        mod.GlobalWorkerOptions.workerSrc = workerUrl
        workerReady = true
      }
      return mod
    })()
  }
  return pdfjsPromise
}

export interface PdfPreviewHandle {
  /** Page count in the document */
  pageCount: number
  /** Clears the container and releases the document */
  destroy: () => void
}

/**
 * Preloads pdf.js + the worker module (fake worker) ahead of time so the first
 * preview render does not wait for heavy chunks (~1.6 MB). Idempotent:
 * repeated calls return the same promise (module cache).
 */
export function preloadPdfPreview(): Promise<unknown> {
  return loadPdfjs()
}

/**
 * Renders all PDF pages into the container (canvas + page number, fitted to the
 * container width). Returns a handle for cleanup. On error the container is
 * cleared and the exception is rethrown. The whole render is bounded by
 * a timeout — the preview cannot "hang" (endless spinner).
 */
export async function renderPdfPreview(bytes: Uint8Array, container: HTMLElement): Promise<PdfPreviewHandle> {
  const pdfjs = await loadPdfjs()
  container.innerHTML = ''

  // Byte copy: pdf.js takes the TypedArray over (transfer)
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const loadingTask = pdfjs.getDocument({ data: copy, isEvalSupported: false })
  const destroyed = { value: false }

  /** Wraps a promise with a timeout: on expiry destroy the task and reject */
  const withTimeout = <T>(p: Promise<T>, ms: number, msg: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = window.setTimeout(() => {
        void loadingTask.destroy()
        reject(new Error(msg))
      }, ms)
      p.then(
        (v) => {
          window.clearTimeout(t)
          resolve(v)
        },
        (e) => {
          window.clearTimeout(t)
          reject(e)
        },
      )
    })

  const run = async (): Promise<PdfPreviewHandle> => {
    const doc = await withTimeout(loadingTask.promise, RENDER_TIMEOUT_MS, t('pdf.preview.openTimeout'))
    const pageCount = doc.numPages
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const targetW = Math.max((container.clientWidth || 560) - 16, 220)

    for (let i = 1; i <= pageCount; i++) {
      const page = await doc.getPage(i)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(targetW / base.width, 1.25) * dpr
      const viewport = page.getViewport({ scale })

      const wrap = document.createElement('div')
      wrap.className = 'pe-page'
      const canvas = document.createElement('canvas')
      canvas.className = 'pe-page-canvas'
      canvas.width = Math.max(1, Math.floor(viewport.width))
      canvas.height = Math.max(1, Math.floor(viewport.height))
      canvas.style.width = `${(canvas.width / dpr).toFixed(1)}px`
      canvas.style.height = `${(canvas.height / dpr).toFixed(1)}px`
      wrap.appendChild(canvas)
      if (pageCount > 1) {
        const num = document.createElement('span')
        num.className = 'pe-page-num'
        num.textContent = String(i)
        wrap.appendChild(num)
      }
      container.appendChild(wrap)

      const ctx = canvas.getContext('2d')
      if (ctx) await page.render({ canvasContext: ctx, viewport }).promise
      page.cleanup()
    }

    return {
      pageCount,
      destroy: () => {
        if (destroyed.value) return
        destroyed.value = true
        void loadingTask.destroy()
        container.innerHTML = ''
      },
    }
  }

  try {
    return await withTimeout(run(), RENDER_TIMEOUT_MS, t('pdf.preview.renderTimeout'))
  } catch (e) {
    void loadingTask.destroy()
    container.innerHTML = ''
    throw e
  }
}
