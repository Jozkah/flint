// Desktop events forwarded to connected phones: approvals asked and answered,
// runs started and finished, and notifications. Derived by watching the
// stores that already hold this state, so no run path needs to know about
// remote access.

import { useAppState } from '@/hooks/useAppState'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { useRoomsStore } from '@/lib/rooms/store'
import type { RemoteEvent, SessionKind } from './protocol'

export type RemoteEmit = (event: RemoteEvent) => void

/** What was added to and removed from a set of ids. */
export function diffIds(
  prev: ReadonlySet<string>,
  next: ReadonlySet<string>
): { added: string[]; removed: string[] } {
  return {
    added: [...next].filter((id) => !prev.has(id)),
    removed: [...prev].filter((id) => !next.has(id)),
  }
}

type Watch<S> = {
  subscribe: (listener: (state: S) => void) => () => void
  getState: () => S
}

/** Calls `onChange` with the ids added and removed each time `select`'s
 * result changes. */
export function watchIds<S>(
  store: Watch<S>,
  select: (state: S) => ReadonlySet<string>,
  onChange: (d: { added: string[]; removed: string[] }, state: S) => void
): () => void {
  let prev = select(store.getState())
  return store.subscribe((state) => {
    const next = select(state)
    const d = diffIds(prev, next)
    prev = next
    if (d.added.length || d.removed.length) onChange(d, state)
  })
}

const runWatcher = <S>(
  kind: SessionKind,
  store: Watch<S>,
  select: (s: S) => ReadonlySet<string>,
  emit: RemoteEmit
) =>
  watchIds(store, select, ({ added, removed }) => {
    added.forEach((id) => emit({ type: 'run.started', kind, id }))
    removed.forEach((id) => emit({ type: 'run.finished', kind, id }))
  })

let notify: RemoteEmit | null = null

/** A notification for connected phones; a no-op while forwarding is off. */
export function emitRemoteNotification(title: string, body: string): void {
  notify?.({ type: 'notification', title, body })
}

/** Starts forwarding; returns the function that stops it. */
export function startRemoteEventForwarding(emit: RemoteEmit): () => void {
  notify = emit
  const stops = [
    watchIds(
      useToolApprovalRequests,
      (s) => new Set(allApprovalRequests(s).map((a) => a.requestId)),
      ({ added, removed }, s) => {
        const byId = new Map(allApprovalRequests(s).map((a) => [a.requestId, a]))
        for (const id of added) {
          const a = byId.get(id)
          if (a) {
            emit({
              type: 'approval.requested',
              requestId: id,
              toolName: a.toolName,
              threadId: a.threadId,
            })
          }
        }
        removed.forEach((id) => emit({ type: 'approval.resolved', requestId: id }))
      }
    ),
    runWatcher(
      'chat',
      useAppState,
      (s) =>
        new Set(
          Object.entries(s.busyThreads)
            .filter(([, b]) => b)
            .map(([id]) => id)
        ),
      emit
    ),
    runWatcher('cowork', useCoworkRun, (s) => new Set(Object.keys(s.runs)), emit),
    runWatcher('room', useRoomsStore, (s) => new Set(s.runningRoomIds), emit),
  ]
  return () => {
    if (notify === emit) notify = null
    stops.forEach((stop) => stop())
  }
}
