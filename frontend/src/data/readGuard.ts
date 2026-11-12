export function createReadGuard() {
  let generation = 0
  return {
    begin() {
      const current = ++generation
      return { isCurrent: () => current === generation }
    },
    invalidate() { generation++ },
  }
}
