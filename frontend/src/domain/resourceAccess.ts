export function resourceHeaderRows<T extends { owner_id?: number }>(rows: T[], userId: number | null | undefined): T[] {
  return userId == null ? [] : rows.filter((row) => row.owner_id === userId)
}

export function resourceHeaderOwners<T extends { id?: number }>(users: T[], rows: { owner_id?: number }[]): T[] {
  const owners = new Set(rows.map(row => row.owner_id))
  return users.filter(user => user.id != null && owners.has(user.id))
}

/** Filter presentation only; assignment data remains intact for load calculations and editing. */
export function resourceBadgeRows<T extends { resource_id: number }>(rows: T[], visibleIds?: ReadonlySet<number>): T[] {
  return visibleIds == null ? rows : rows.filter(row => visibleIds.has(row.resource_id))
}
