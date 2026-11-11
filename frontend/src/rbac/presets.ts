/**
 * Reserved (built-in) preset tags — the stable identifiers the RBAC engine
 * protects from rename/delete (mirrors internal/user/domain/models.go on the
 * backend). Custom presets have their own tags and are never referenced by
 * these constants. Business logic must compare presets through the helpers
 * here, never by raw string literals scattered across the codebase.
 */
export const PRESET_TAGS = {
  /** Administrator — full bypass (bootstrapped, protected). */
  admin: 'admin',
  /** Project director — full project scope. */
  projectDirector: 'dp',
  /** Project manager — owns projects/processes. */
  projectManager: 'rp',
  /** Process owner. */
  processOwner: 'vp',
  /** Line worker — the only non-owner built-in preset. */
  worker: 'worker',
} as const

export type PresetTag = (typeof PRESET_TAGS)[keyof typeof PRESET_TAGS]

/** Whether a preset tag is the line-worker preset (i.e. not an owner candidate). */
export function isWorkerPreset(preset?: string | null): boolean {
  return preset === PRESET_TAGS.worker
}
