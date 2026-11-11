import { toggleScopeMove } from '@/rbacScope'
import { NO_ACCESS } from './rbacGrid'

export const PRESET_DEFAULT_SCOPES: Record<string, string> = {
  resource: 'self', project: 'self', process: 'up1', task: 'up1', milestone: 'up1', assignment: 'up1',
}

export function parentScope(resource: string, scope: string): string {
  if (resource !== 'process' && resource !== 'task') return scope
  return [...new Set(scope.trim().split(/\s+/).map((part) => part === 'self' || part === 'own' ? 'up1' : part))].join(' ')
}

export function togglePresetScope(scope: string, move: string): string {
  return toggleScopeMove(scope, move) || NO_ACCESS
}
