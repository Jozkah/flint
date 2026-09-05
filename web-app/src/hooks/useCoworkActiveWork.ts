import { create } from 'zustand'
import type { AccessMode } from '@/lib/coworkAccess'
import type { WriteDestination } from '@/lib/coworkReadiness'

/**
 * Everything currently able to touch the filesystem, in one place.
 *
 * Access used to be gated on a handful of unrelated booleans — a run flag, a
 * polled job list, a transition flag — which between them still left gaps: a
 * subagent or a foreground shell could be mid-write while the folder was
 * swapped underneath it. The question "may authority change right now?" has one
 * answer here, and everything that can write registers itself.
 *
 * Each item carries the authority it *started* with. That is the point: a
 * background job keeps writing where it was authorized to write, and a later
 * preference change cannot retroactively move or widen it.
 *
 * Nothing here is persisted. Work does not survive a reload, and neither does
 * the authority it was holding.
 */

export type WorkKind =
  | 'run'
  | 'subagent'
  | 'shell'
  | 'job'
  | 'authorizing'
  | 'revoking'

/** The authority an operation began under, frozen for its lifetime. */
export type WorkAuthority = {
  folder: string | null
  access: AccessMode
  destination: WriteDestination
}

export type WorkItem = {
  id: string
  sessionId: string
  kind: WorkKind
  authority: WorkAuthority
}

/**
 * Which reason to show when several things are running.
 *
 * Ordered by what a person can act on: stopping a run is a thing you do, so it
 * is named before the transition that will finish by itself.
 */
const REASON_ORDER: WorkKind[] = [
  'run',
  'subagent',
  'shell',
  'job',
  'authorizing',
  'revoking',
]

type ActiveWorkState = {
  items: Record<string, WorkItem>
  /**
   * Register work and get its release back.
   *
   * The release closes over the id, so it can only ever end *this* item — a
   * late completion event from something else cannot clear it, and calling it
   * twice does nothing the second time.
   */
  acquire: (item: Omit<WorkItem, 'id'> & { id?: string }) => () => void
  /** End one item by id. Harmless when it has already ended. */
  release: (id: string) => void
  /** Everything still running for a session. */
  activeFor: (sessionId: string | null | undefined) => WorkItem[]
  /** The kind to explain, or null when nothing is running. */
  blockingKind: (sessionId: string | null | undefined) => WorkKind | null
  /** Drop a session's items outright. For teardown, not for completion. */
  clearSession: (sessionId: string) => void
}

let counter = 0
const nextId = () => `work-${++counter}`

export const useCoworkActiveWork = create<ActiveWorkState>()((set, get) => ({
  items: {},

  acquire: (item) => {
    const id = item.id ?? nextId()
    set((s) => ({ items: { ...s.items, [id]: { ...item, id } } }))
    let released = false
    return () => {
      // Guarded here as well as in `release`, so a caller holding the closure
      // cannot end a *later* item that happened to reuse the id.
      if (released) return
      released = true
      get().release(id)
    }
  },

  release: (id) =>
    set((s) => {
      if (!(id in s.items)) return s
      const items = { ...s.items }
      delete items[id]
      return { items }
    }),

  activeFor: (sessionId) =>
    sessionId
      ? Object.values(get().items).filter((one) => one.sessionId === sessionId)
      : [],

  blockingKind: (sessionId) => {
    const active = get().activeFor(sessionId)
    if (active.length === 0) return null
    return (
      REASON_ORDER.find((kind) => active.some((one) => one.kind === kind)) ??
      active[0].kind
    )
  },

  clearSession: (sessionId) =>
    set((s) => {
      const items = Object.fromEntries(
        Object.entries(s.items).filter(([, one]) => one.sessionId !== sessionId)
      )
      return Object.keys(items).length === Object.keys(s.items).length
        ? s
        : { items }
    }),
}))

/**
 * May this session's authority change right now?
 *
 * The one question the selector, the folder controls and destructive session
 * actions all ask, so none of them can answer it differently.
 */
export const authorityMayChange = (
  sessionId: string | null | undefined
): boolean => useCoworkActiveWork.getState().blockingKind(sessionId) === null
