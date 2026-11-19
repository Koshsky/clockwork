import { ref } from 'vue'
import type { NativeDiagnosticReport } from '@/diagnostics/native'
export const nativeDiagnosticsOpen = ref(false)
export const nativeDiagnosticReport = ref<NativeDiagnosticReport | null>(null)
export const nativeDiagnosticState = ref<'idle' | 'loading' | 'failed' | 'saved' | 'saving'>('idle')
export const closeNativeDiagnostics = () => {}
export const openNativeDiagnostics = async () => {}
export const saveNativeDiagnostics = async () => {}
export const captureNativeError = () => {}
