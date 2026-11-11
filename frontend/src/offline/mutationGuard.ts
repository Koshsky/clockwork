let revision = 0
let active = 0

/** Reads begun before or during a local write cannot replace its optimistic state. */
export function beginMutation(): () => void {
  revision++
  active++
  let finished = false
  return () => {
    if (finished) return
    finished = true
    active--
    revision++
  }
}

export function hasActiveMutations(): boolean {
  return active > 0
}

export function readStamp(): number | null {
  return active === 0 ? revision : null
}

export function mayApplyRead(stamp: number | null): boolean {
  return stamp != null && active === 0 && stamp === revision
}
