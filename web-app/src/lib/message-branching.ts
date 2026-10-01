import {
  ThreadMessage,
  ContentType,
  MessageStatus,
  ChatCompletionRole,
} from '@janhq/core'

type ThreadContent = NonNullable<ThreadMessage['content']>[number]

/**
 * Message versioning model: a parent-pointer tree stored in `metadata`.
 *
 * - `metadata.parentId` links a message to its predecessor. Messages sharing a
 *   `parentId` (or both rootless) are sibling versions.
 * - `metadata.activeChildId` selects which child branch is shown; absent ⇒ the
 *   newest sibling (by `created_at`) wins.
 *
 * The visible/sent conversation is the path from the active root down the active
 * child at each node. Legacy threads carry no branching metadata and are treated
 * as a single linear path until the first fork backfills parent links.
 */

const meta = (m: ThreadMessage) =>
  (m.metadata ?? {}) as Record<string, unknown>

// Raw link: `undefined` ⇒ legacy/unlinked, `null` ⇒ explicit root, string ⇒ parent.
const rawParent = (m: ThreadMessage): string | null | undefined => {
  const p = meta(m).parentId
  if (p === null) return null
  return typeof p === 'string' ? p : undefined
}

export const getParentId = (m: ThreadMessage): string | null => {
  const p = rawParent(m)
  return typeof p === 'string' ? p : null
}

export const getActiveChildId = (m: ThreadMessage): string | undefined => {
  const c = meta(m).activeChildId
  return typeof c === 'string' ? c : undefined
}

/** True once any message carries branching metadata. */
export const hasBranching = (messages: ThreadMessage[]): boolean =>
  messages.some(
    (m) => meta(m).parentId !== undefined || meta(m).activeChildId !== undefined
  )

const byCreatedAt = (a: ThreadMessage, b: ThreadMessage) =>
  (a.created_at ?? 0) - (b.created_at ?? 0)

/** Sibling versions of `m` (same parent, or fellow roots), oldest → newest. */
export const getSiblings = (
  messages: ThreadMessage[],
  m: ThreadMessage
): ThreadMessage[] => {
  const pid = rawParent(m)
  // Legacy/unlinked messages have no version siblings.
  if (pid === undefined) return [m]
  return messages.filter((x) => rawParent(x) === pid).sort(byCreatedAt)
}

/** 1-based position of `m` among its versions and the total count. */
export const getVersionInfo = (
  messages: ThreadMessage[],
  m: ThreadMessage
): { index: number; count: number } => {
  const siblings = getSiblings(messages, m)
  const idx = siblings.findIndex((x) => x.id === m.id)
  return { index: idx === -1 ? 1 : idx + 1, count: siblings.length }
}

const childrenOf = (
  messages: ThreadMessage[],
  parentId: string | null
): ThreadMessage[] =>
  messages.filter((x) => rawParent(x) === parentId).sort(byCreatedAt)

/** The active child of `parent`: its `activeChildId` if still valid, else newest. */
export const pickActiveChild = (
  messages: ThreadMessage[],
  parent: ThreadMessage
): ThreadMessage | undefined => {
  const children = childrenOf(messages, parent.id)
  if (children.length === 0) return undefined
  const activeId = getActiveChildId(parent)
  const chosen = activeId && children.find((c) => c.id === activeId)
  return chosen || children[children.length - 1]
}

/**
 * The visible linear conversation. Legacy (un-branched) threads are returned
 * unchanged; otherwise walk from the active root following the active child.
 */
export const computeActivePath = (
  messages: ThreadMessage[],
  activeRootId?: string
): ThreadMessage[] => {
  if (!hasBranching(messages)) return messages

  const roots = childrenOf(messages, null)
  if (roots.length === 0) return messages

  const root =
    (activeRootId && roots.find((r) => r.id === activeRootId)) ||
    roots[roots.length - 1]

  const path: ThreadMessage[] = []
  let cur: ThreadMessage | undefined = root
  const seen = new Set<string>()
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id)
    path.push(cur)
    cur = pickActiveChild(messages, cur)
  }
  return path
}

/** Return a copy of `m` with `parentId` set in metadata. */
export const withParentId = (
  m: ThreadMessage,
  parentId: string | null
): ThreadMessage => ({
  ...m,
  metadata: { ...(m.metadata ?? {}), parentId },
})

/** Return a copy of `m` with `activeChildId` set in metadata. */
export const withActiveChild = (
  m: ThreadMessage,
  childId: string
): ThreadMessage => ({
  ...m,
  metadata: { ...(m.metadata ?? {}), activeChildId: childId },
})

/**
 * Assign `parentId` along a linear path so the tree is well-formed before the
 * first fork. Returns only the messages that need a write (empty if already
 * branched). `path` must be in conversation order.
 */
export const backfillParentIds = (path: ThreadMessage[]): ThreadMessage[] => {
  if (path.some((m) => meta(m).parentId !== undefined)) return []
  return path.map((m, i) => withParentId(m, i === 0 ? null : path[i - 1].id))
}

/**
 * Repair threads corrupted on disk by the assistant-orphan bug (#8357 and its
 * earlier variants): in a branched thread an assistant reply was persisted with
 * a detached parent link -- either `parentId: null` or no `parentId` at all.
 * `computeActivePath` then treats it as a phantom root / non-child and drops it,
 * so the conversation renders as user messages in a row with the replies gone.
 *
 * The break compounds: because the reply is detached, the *following* user turn
 * was linked to the previous user instead of to that reply, so the whole tail
 * hangs off the wrong nodes. Repair each detached assistant by:
 *   1. re-parenting it to the user turn it answers (nearest preceding user by
 *      `created_at`, mirroring `resolveAssistantParent`), and
 *   2. re-linking the user turn that follows it (currently a child of that same
 *      user) onto the assistant, restoring the alternating chain so every later
 *      turn rejoins the active path.
 * Genuine version forks are preserved: only detached assistants and the single
 * user turn each one displaced are touched.
 *
 * Returns only the messages that need a write (empty when nothing is broken).
 * Idempotent: once linked, an assistant has a string parent and is skipped.
 * No-op on legacy (un-branched) threads -- without branching, `computeActivePath`
 * returns messages unchanged, so a missing parent is harmless there.
 */
export const repairDetachedAssistants = (
  messages: ThreadMessage[]
): ThreadMessage[] => {
  if (!hasBranching(messages)) return []
  const ordered = [...messages].sort(byCreatedAt)
  const writes = new Map<string, ThreadMessage>()
  const parentOf = (m: ThreadMessage) => rawParent(writes.get(m.id) ?? m)

  for (let i = 0; i < ordered.length; i++) {
    const a = ordered[i]
    if (a.role !== ChatCompletionRole.Assistant) continue
    const p = parentOf(a)
    if (p !== null && p !== undefined) continue

    let user: ThreadMessage | undefined
    for (let j = i - 1; j >= 0; j--) {
      if (ordered[j].role === ChatCompletionRole.User) {
        user = ordered[j]
        break
      }
    }
    if (!user) continue
    writes.set(a.id, withParentId(writes.get(a.id) ?? a, user.id))

    for (let j = i + 1; j < ordered.length; j++) {
      const c = ordered[j]
      if (c.role === ChatCompletionRole.User && parentOf(c) === user.id) {
        writes.set(c.id, withParentId(writes.get(c.id) ?? c, a.id))
        break
      }
    }
  }

  return [...writes.values()]
}

/**
 * Take messages out of the tree without cutting off what hangs below them.
 *
 * Deleting a message used to drop just that row. Its children kept a `parentId`
 * naming a message that no longer existed, so `computeActivePath` could never
 * reach them and the whole tail of the conversation vanished from the UI while
 * `messages.jsonl` still held it (janhq/jan#8495). The same happened to the
 * load-time cleanup of empty assistant rows: the user turn sent after an
 * errored generation hangs off that empty row, so dropping the row dropped
 * everything after it.
 *
 * Each child of a removed message is re-parented to the removed message's own
 * parent (walking past chains of removed messages), and a parent whose
 * `activeChildId` pointed at the removed message now points at the child that
 * took its place. Returns the surviving messages that need a write.
 */
export const removeFromTree = (
  messages: ThreadMessage[],
  removeIds: Iterable<string>
): ThreadMessage[] => {
  const removed = new Set(removeIds)
  if (removed.size === 0 || !hasBranching(messages)) return []
  const byId = new Map(messages.map((m) => [m.id, m]))
  const writes = new Map<string, ThreadMessage>()
  const current = (m: ThreadMessage) => writes.get(m.id) ?? m

  // The nearest ancestor of a removed message that survives.
  const survivingAncestor = (id: string): string | null => {
    const seen = new Set<string>()
    let cursor: string | null = id
    while (cursor && removed.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor)
      const node = byId.get(cursor)
      cursor = node ? getParentId(node) : null
    }
    return cursor && !removed.has(cursor) ? cursor : null
  }

  for (const child of [...messages].sort(byCreatedAt)) {
    if (removed.has(child.id)) continue
    const pid = rawParent(current(child))
    if (typeof pid !== 'string' || !removed.has(pid)) continue
    const newParent = survivingAncestor(pid)
    writes.set(child.id, withParentId(current(child), newParent))

    if (newParent) {
      const parent = byId.get(newParent)
      if (!parent) continue
      const active = getActiveChildId(current(parent))
      if (active === undefined || removed.has(active)) {
        writes.set(newParent, withActiveChild(current(parent), child.id))
      }
    }
  }

  return [...writes.values()]
}

/**
 * Re-attach messages whose `parentId` names a message that is gone -- threads
 * already damaged by the delete path `removeFromTree` now handles. Each is
 * hung off the nearest earlier surviving message by `created_at`, which is the
 * turn it followed when it was written, and becomes that message's active
 * child when the parent's own selection is missing or dangling.
 *
 * Returns only the messages that need a write. No-op on legacy threads and on
 * healthy ones.
 */
export const repairDanglingParents = (
  messages: ThreadMessage[]
): ThreadMessage[] => {
  if (!hasBranching(messages)) return []
  const present = new Set(messages.map((m) => m.id))
  const ordered = [...messages].sort(byCreatedAt)
  const writes = new Map<string, ThreadMessage>()
  const current = (m: ThreadMessage) => writes.get(m.id) ?? m

  ordered.forEach((m, i) => {
    const pid = rawParent(m)
    if (typeof pid !== 'string' || present.has(pid)) return
    const previous = i > 0 ? ordered[i - 1] : undefined
    writes.set(m.id, withParentId(current(m), previous ? previous.id : null))
    if (!previous) return
    const active = getActiveChildId(current(previous))
    if (active === undefined || !present.has(active)) {
      writes.set(previous.id, withActiveChild(current(previous), m.id))
    }
  })

  return [...writes.values()]
}

export type ContinuationPlan = {
  parentId: string | null
  deletePartialId: string | null
}

/**
 * Resume a stopped assistant turn in place. The continued reply inherits the
 * stale partial's parent, and that partial is dropped, so the reply replaces it
 * rather than forking a sibling version. Falls back to `fallbackParentId` when
 * no partial is targeted or its id is stale.
 */
export const planContinuation = (
  messages: ThreadMessage[],
  replyId: string,
  partialId: string | null | undefined,
  fallbackParentId: string | null
): ContinuationPlan => {
  const partial = partialId
    ? messages.find((m) => m.id === partialId)
    : undefined
  const parentId = (partial ? getParentId(partial) : null) ?? fallbackParentId
  const deletePartialId =
    partial && partial.id !== replyId ? partial.id : null
  return { parentId, deletePartialId }
}

/**
 * Build a new sibling version of `source`: fresh id/timestamp, same parent,
 * no children, optional text override. Used for edit-user / edit-assistant forks.
 */
export const makeSibling = (
  source: ThreadMessage,
  opts: { id: string; createdAt: number; text?: string }
): ThreadMessage => {
  // An edit replaces the text and keeps the images: they live only in the
  // content, so rebuilding it from the new text alone lost them for good.
  // Reasoning and tool calls belong to an answer the edit just invalidated.
  const content: ThreadContent[] =
    opts.text !== undefined
      ? [
          { type: ContentType.Text, text: { value: opts.text, annotations: [] } },
          ...source.content
            .filter((c) => c.type === ContentType.Image)
            .map((c) => ({ ...c })),
        ]
      : source.content.map((c) => ({ ...c }))
  const sourceMeta = { ...(source.metadata ?? {}) } as Record<string, unknown>
  delete sourceMeta.activeChildId
  delete sourceMeta.error
  return {
    ...source,
    id: opts.id,
    content,
    status: MessageStatus.Ready,
    created_at: opts.createdAt,
    completed_at: opts.createdAt,
    metadata: { ...sourceMeta, parentId: getParentId(source) },
  }
}

/** The root the thread has selected, from its metadata (`undefined` ⇒ newest). */
export const activeRootIdOf = (
  threadMetadata: Record<string, unknown> | undefined | null
): string | undefined => {
  const id = threadMetadata?.activeRootId
  return typeof id === 'string' ? id : undefined
}

/**
 * The conversation the user is looking at, given the thread's metadata. Every
 * reader that wants "the chat" (token counts, titles, previews, the phone,
 * export) goes through this rather than reading the stored list, which also
 * holds the versions that are not on screen.
 */
export const activePathOf = (
  messages: ThreadMessage[],
  threadMetadata?: Record<string, unknown> | null
): ThreadMessage[] =>
  computeActivePath(messages, activeRootIdOf(threadMetadata))

/**
 * Every root-to-leaf path of the tree, oldest branch first; the active path is
 * one of them. A thread with no branching is one path.
 */
export const allBranchPaths = (
  messages: ThreadMessage[]
): ThreadMessage[][] => {
  if (!hasBranching(messages)) return messages.length ? [messages] : []
  const paths: ThreadMessage[][] = []
  const walk = (node: ThreadMessage, trail: ThreadMessage[]) => {
    if (trail.some((t) => t.id === node.id)) return
    const next = [...trail, node]
    const kids = childrenOf(messages, node.id)
    if (kids.length === 0) paths.push(next)
    else kids.forEach((k) => walk(k, next))
  }
  childrenOf(messages, null).forEach((r) => walk(r, []))
  return paths.length ? paths : [messages]
}
