import type { DtoCommentResponse, DtoUserInfo } from '@/api'

/** Flat discussion-tree node (pre-order) for indented rendering */
export interface CommentFlatNode {
  comment: DtoCommentResponse
  /** Nesting depth (0 — root/orphaned) */
  depth: number
  /** Parent deleted — the reply is shown at the top level with a marker */
  orphan: boolean
}

export interface TaskCommentsProps {
  embedded?: boolean
  open: boolean
  taskId: number
  taskTitle?: string
  /** Flat list of the task's comments (GET /task/{id}/comments) */
  comments?: DtoCommentResponse[]
  /** User directory for author names (author_id → name) */
  users?: DtoUserInfo[]
  busy?: boolean
  error?: string | null
  /** Reason for blocking sending (e.g. offline); null — sending available */
  disabledReason?: string | null
  /** Permission to delete others' comments (admin/vp); authors always delete their own */
  canManage?: boolean
  /** Current user — for the "Delete" button on own comments */
  userId?: number | null
}

export interface SendCommentPayload {
  content: string
  parent_id?: number
}

export interface DeleteCommentPayload {
  comment_id: number
}

/** Builds a pre-order flat list: replies follow their parent indented.
 *  If parent_id references a missing (deleted) comment — the node
 *  is lifted to the top level with the orphan marker. */
export function flattenComments(list: DtoCommentResponse[]): CommentFlatNode[] {
  const byId = new Map<number, DtoCommentResponse>()
  for (const c of list) if (c.id != null) byId.set(c.id, c)

  const childrenOf = new Map<number, DtoCommentResponse[]>()
  for (const c of list) {
    const pid = c.parent_id
    if (pid != null && byId.has(pid)) {
      const arr = childrenOf.get(pid) ?? []
      arr.push(c)
      childrenOf.set(pid, arr)
    }
  }

  const out: CommentFlatNode[] = []
  const walk = (c: DtoCommentResponse, depth: number, orphan: boolean) => {
    out.push({ comment: c, depth, orphan })
    const kids = childrenOf.get(c.id ?? -1) ?? []
    for (const child of kids) walk(child, depth + 1, false)
  }

  for (const c of list) {
    // Roots: no parent_id or a parent_id absent from the list (deleted).
    if (c.parent_id != null && byId.has(c.parent_id)) continue
    walk(c, 0, c.parent_id != null && !byId.has(c.parent_id))
  }
  return out
}