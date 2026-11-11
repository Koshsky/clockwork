import type { TimelineCtx } from '@/composables/timeline-context'
import type { LinkStyle } from '@/components/planner/linkStyle'
import type { DependencyEdge } from '../../../../../dependencies'

/**
 * One dependency connector between two top-level task rows of a process.
 * The geometry lives in `planner/dependencyPaths.ts` (pure + unit-tested); this
 * type only pairs it with the edge identity for the `v-for` key.
 */
export interface DependencyArrow {
  key: string
  /** Cubic Bézier `d` of the connector (container-local px). */
  d: string
  /** Terminus tick `d` on the constrained date (container-local px). */
  tick: string
}

export interface TaskDependencyLinksProps {
  timeline: TimelineCtx
  tasks: Array<{ id: number; start_date: string; end_date: string }>
  dependencies?: DependencyEdge[]
  /**
   * Connector style override. The app leaves it unset, so the links follow the
   * user's choice in Settings (viewSettings.connector); stories set it to stay
   * deterministic regardless of the saved setting.
   */
  connector?: LinkStyle
}
