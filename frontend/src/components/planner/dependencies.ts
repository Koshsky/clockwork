export * from '@/domain/dependencies'
import type { DependencyType } from '@/domain/dependencies'
import { t } from '@/i18n'

/**
 * Localized label of a link type. Built per call instead of a module-level map,
 * so a language switch re-renders the selects and option lists that use it.
 */
export function dependencyLabel(type: DependencyType): string {
  return t(`planner.dependencies.${type}`)
}

/** Labels of every link type, in `DEPENDENCY_TYPES` order (call-time, reactive). */
export function dependencyLabels(): Record<DependencyType, string> {
  return {
    fs: dependencyLabel('fs'),
    ss: dependencyLabel('ss'),
    ff: dependencyLabel('ff'),
    sf: dependencyLabel('sf'),
  }
}
