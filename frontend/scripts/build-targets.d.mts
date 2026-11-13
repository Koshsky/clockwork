import type { Plugin } from 'vite'
export function buildTarget(command: string, requested?: string): 'web' | 'desktop' | 'auto'
export function webApiPath(requested?: string): '/api/v1'
export function rendererReplacement(target: string, root: string, source: string, importer?: string): string | null
export function inspectRendererModules(target: string, root: string, ids: string[]): string[]
export function rendererBuildComposition(target: 'web' | 'desktop', version: string): Plugin
