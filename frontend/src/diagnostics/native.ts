import { ref, watch } from 'vue'
import { desktopSessionState } from '@/session/desktop'
import { diagnosticEvent } from '@/domain/diagnostics'
import type { WebDiagnosticKind } from './history'

export interface NativeDiagnosticReport {
  schema: number
  platform: 'desktop'
  frontend_version: string
  backend_version: string
  journal: { status: string; dropped: number }
  state: { mode: string; queue: Record<string, number | null> | null }
  records: unknown[]
}
export interface NativeDiagnosticPreview { contextId: string; snapshotId: string; report: NativeDiagnosticReport }
export interface NativeDiagnosticBridge {
  request(request: { action: 'preview'; contextId: string } | { action: 'save'; contextId: string; snapshotId: string }
    | { action: 'record'; contextId: string; kind: WebDiagnosticKind; diagnostic: ReturnType<typeof diagnosticEvent> }): Promise<unknown>
}
export const nativeDiagnosticsOpen = ref(false)
export const nativeDiagnosticReport = ref<NativeDiagnosticReport | null>(null)
export const nativeDiagnosticState = ref<'idle' | 'loading' | 'failed' | 'saved' | 'saving'>('idle')
let preview: NativeDiagnosticPreview | null = null
let revision = 0
export function closeNativeDiagnostics() {
  revision++; nativeDiagnosticsOpen.value = false; nativeDiagnosticReport.value = null; preview = null; nativeDiagnosticState.value = 'idle'
}
watch(() => desktopSessionState.value?.contextId, closeNativeDiagnostics, { flush: 'sync' })
export async function openNativeDiagnostics() {
  const contextId = desktopSessionState.value?.contextId
  nativeDiagnosticsOpen.value = true; nativeDiagnosticState.value = 'loading'; nativeDiagnosticReport.value = null; preview = null
  const own = ++revision
  try {
    if (!contextId || !window.erpDesktop?.diagnostics) throw new Error('DIAGNOSTICS_UNAVAILABLE')
    const value = await window.erpDesktop.diagnostics.request({ action: 'preview', contextId }) as NativeDiagnosticPreview
    if (own !== revision || contextId !== desktopSessionState.value?.contextId) return
    if (value.contextId !== contextId || !value.snapshotId || value.report?.platform !== 'desktop') throw new Error('DIAGNOSTICS_INVALID')
    preview = value; nativeDiagnosticReport.value = value.report; nativeDiagnosticState.value = 'idle'
  } catch { if (own === revision) nativeDiagnosticState.value = 'failed' }
}
export async function saveNativeDiagnostics() {
  const value = preview, own = revision
  if (!value || nativeDiagnosticState.value === 'saving' || value.contextId !== desktopSessionState.value?.contextId) return
  nativeDiagnosticState.value = 'saving'
  try {
    const result = await window.erpDesktop!.diagnostics!.request({ action: 'save', contextId: value.contextId, snapshotId: value.snapshotId }) as { saved: boolean }
    if (own === revision) nativeDiagnosticState.value = result.saved ? 'saved' : 'idle'
  } catch { if (own === revision) nativeDiagnosticState.value = 'failed' }
}
export function captureNativeError(kind: WebDiagnosticKind, error?: unknown) {
  const contextId = desktopSessionState.value?.contextId
  if (!contextId) return
  try {
    void window.erpDesktop?.diagnostics?.request({ action: 'record', contextId, kind,
      diagnostic: diagnosticEvent('diagnostic', error, { platform: 'desktop', version: __APP_VERSION__ }) }).catch(() => {})
  } catch { /* Native diagnostics are never required for rendering or queue changes. */ }
}
