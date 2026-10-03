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
import { useMessageQueue } from '@/stores/message-queue-store'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { coworkLiveReply, type LiveReply } from './live'
import { reportLiveReply, setStreamSink } from './streams'
import { threadTopic, type RemoteEvent, type SessionKind } from './protocol'
import { asksIn } from './appAsks'
import { appPrompts } from './appPrompts'
import { useAccessRequests } from '@/lib/accessRequests'
import { useBrowserAgentPrompt } from '@/hooks/useBrowserAgentPrompt'
import { useContextSizeApproval } from '@/hooks/useModelContextApproval'
import { useTeamConflictRequests } from '@/hooks/useTeamConflictRequests'
import type { CoworkTurn } from '@/types/coworkSession'

/** The questions waiting in the live lanes, by request id. */
const liveAsks = (liveTurns: Record<string, CoworkTurn[] | undefined>) =>
  new Map(asksIn(liveTurns).map((a) => [a.requestId, a]))

/** Sends one event; `topic` limits it to phones following that topic. */
export type RemoteEmit = (event: RemoteEvent, topic?: string) => void

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
/** Ids whose value under `select` changed (by reference), added or removed. */
export function changedKeys<T>(
  prev: Record<string, T>,
  next: Record<string, T>
): string[] {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  return [...keys].filter((k) => prev[k] !== next[k])
}

function watchRecord<S, T>(
  store: Watch<S>,
  select: (s: S) => Record<string, T>,
  onChange: (ids: string[], state: S) => void
): () => void {
  let prev = select(store.getState())
  return store.subscribe((state) => {
    const next = select(state)
    if (next === prev) return
    const ids = changedKeys(prev, next)
    prev = next
    if (ids.length) onChange(ids, state)
  })
}

/** A Cowork session's live lane, as a reply phones follow. */
export function coworkReplyOf(sid: string): LiveReply | null {
  const run = useCoworkRun.getState()
  const handle = run.runs[sid]
  if (!handle) return null
  const awaiting = new Set(
    allApprovalRequests(useToolApprovalRequests.getState())
      .filter((a) => a.threadId === sid)
      .map((a) => a.toolCallId)
  )
  return coworkLiveReply(handle.runId, run.liveTurns[sid] ?? [], awaiting)
}

/** The desktop's open room's live turn, as a reply phones follow. */
export function roomReplyOf(roomId: string): LiveReply | null {
  const live = useRoomsStore.getState().liveTurn
  if (!live || live.roomId !== roomId) return null
  return {
    messageId: live.turnId,
    text: live.text,
    reasoning: '',
    tools: [],
    ...('name' in live.author ? { author: live.author.name } : {}),
  }
}

/** A message queue belongs to a Cowork session or a chat. */
const queueKind = (id: string): SessionKind =>
  useCoworkSessions.getState().sessions.some((s) => s.id === id) ? 'cowork' : 'chat'

function watchPrompts(emit: RemoteEmit): (() => void)[] {
  let prev = new Set(appPrompts().map((p) => p.id))
  const check = () => {
    const now = appPrompts()
    const next = new Set(now.map((p) => p.id))
    const d = diffIds(prev, next)
    prev = next
    for (const id of d.added) {
      const p = now.find((x) => x.id === id)
      if (p) {
        emit({
          type: 'prompt.requested',
          id,
          kind: p.kind,
          title: p.title,
          ...(p.threadId ? { threadId: p.threadId } : {}),
        })
      }
    }
    d.removed.forEach((id) => emit({ type: 'prompt.resolved', id }))
  }
  return [
    useAccessRequests.subscribe(check),
    useBrowserAgentPrompt.subscribe(check),
    useTeamConflictRequests.subscribe(check),
    useContextSizeApproval.subscribe(check),
  ]
}

export function startRemoteEventForwarding(emit: RemoteEmit): () => void {
  notify = emit
  setStreamSink((event, topic) => emit(event, topic))
  const updated = (kind: SessionKind, id: string) =>
    emit({ type: 'thread.updated', kind, id }, threadTopic(id))
  let liveRoom: string | null = null
  const stops = [
    // A Cowork run's live lane, per session.
    watchRecord(
      useCoworkRun,
      (s) => s.liveTurns,
      (ids) => ids.forEach((sid) => reportLiveReply('cowork', sid, coworkReplyOf(sid)))
    ),
    watchRecord(
      useCoworkRun,
      (s) => s.runs,
      (ids) => ids.forEach((sid) => reportLiveReply('cowork', sid, coworkReplyOf(sid)))
    ),
    // The open room's speaker, and its journal.
    useRoomsStore.subscribe((s, prev) => {
      if (s.liveTurn !== prev.liveTurn) {
        const id = s.liveTurn?.roomId ?? liveRoom
        if (id) reportLiveReply('room', id, roomReplyOf(id))
        liveRoom = s.liveTurn?.roomId ?? null
      }
      if (s.journal !== prev.journal && s.currentRoomId) updated('room', s.currentRoomId)
    }),
    // Queued and steering messages, per conversation.
    watchRecord(
      useMessageQueue,
      (s) => s.queues,
      (ids) => ids.forEach((id) => updated(queueKind(id), id))
    ),
    // A Cowork session's stored messages (a run committed, a message sent).
    watchRecord(
      useCoworkSessions,
      (s) => Object.fromEntries(s.sessions.map((x) => [x.id, x.messages])),
      (ids) => ids.forEach((id) => updated('cowork', id))
    ),
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
              kind: queueKind(a.threadId),
            })
          }
        }
        removed.forEach((id) => emit({ type: 'approval.resolved', requestId: id }))
      }
    ),
    // The other blocking prompts: any of their stores changing is a reason to
    // compare what is waiting now with what was.
    ...watchPrompts(emit),
    // A Cowork run asked something, or its question was answered.
    watchIds(
      useCoworkRun,
      (s) => new Set(liveAsks(s.liveTurns).keys()),
      ({ added, removed }, s) => {
        const byId = liveAsks(s.liveTurns)
        for (const id of added) {
          const a = byId.get(id)
          if (a) {
            emit({
              type: 'ask.requested',
              requestId: id,
              threadId: a.threadId,
              question: a.questions[0]?.question ?? '',
            })
          }
        }
        removed.forEach((id) => emit({ type: 'ask.resolved', requestId: id }))
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
    setStreamSink(null)
    stops.forEach((stop) => stop())
  }
}
