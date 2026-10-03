// What the desktop asks the remote server to send as Web Push. The server
// decides who gets it (devices subscribed, switches on, no page showing,
// quiet hours); this only says what happened, in a few words. No message
// text, tool arguments or paths: a notification shows on a lock screen and
// passes through the browser vendor's push service (encrypted, but still).

import { useAppState } from '@/hooks/useAppState'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useThreads } from '@/hooks/useThreads'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { useRoomsStore } from '@/lib/rooms/store'
import { usePrStatusStore } from '@/stores/pr-status-store'
import type { PushNotice, RemoteEvent, SessionKind } from './protocol'
import { watchIds } from './events'
import { asksIn } from './appAsks'

export type PushEmit = (event: RemoteEvent) => void

/** The phone app's path for a conversation. */
export const pushUrl = (kind: SessionKind, id: string) => `/m/#/${kind}/${encodeURIComponent(id)}`

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function approvalNotice(a: { requestId: string; toolName: string; threadId: string }, where: { kind: SessionKind; title?: string }): PushNotice {
  return {
    category: 'approval',
    title: 'Approval waiting',
    body: where.title ? `${clip(where.title)}: ${a.toolName}` : a.toolName,
    url: pushUrl(where.kind, a.threadId),
    tag: `approval-${a.requestId}`,
    requestId: a.requestId,
  }
}

/** A question is waiting. Sent as an approval: both mean "the run is stopped
 * until you answer", and share the phone's switch. No answer buttons on the
 * notification itself -- a question is answered in the app. */
export function askNotice(threadId: string, title: string | undefined): PushNotice {
  return {
    category: 'approval',
    title: 'Flint has a question',
    body: title ? clip(title) : 'Your Cowork session is waiting for your answer',
    url: pushUrl('cowork', threadId),
    tag: `ask-${threadId}`,
  }
}

export function runEndNotice(
  kind: 'chat' | 'cowork',
  id: string,
  title: string | undefined,
  ending: { stoppedBy?: string | null; errorText?: string | null } | undefined
): PushNotice {
  const failed = !!ending?.errorText
  const stopped = !failed && !!ending?.stoppedBy
  const where = title ? clip(title) : kind === 'chat' ? 'Your chat' : 'Your Cowork session'
  if (failed || stopped) {
    return {
      category: 'runFailed',
      title: failed ? 'Run failed' : 'Run stopped',
      body: where,
      url: pushUrl(kind, id),
      tag: `run-${id}`,
    }
  }
  return {
    category: kind === 'chat' ? 'chatReply' : 'runFinished',
    title: kind === 'chat' ? 'Reply finished' : 'Run finished',
    body: where,
    url: pushUrl(kind, id),
    tag: `run-${id}`,
  }
}

type PrLike = { number: number; title: string; state: string; checks: { failed: number } }

/** A PR that merged or whose checks started failing since `prev`. */
export function prNotice(prev: PrLike | undefined, next: PrLike, sessionId: string | null): PushNotice | null {
  const url = sessionId ? pushUrl('cowork', sessionId) : '/m/'
  if (next.state === 'merged' && prev && prev.state !== 'merged') {
    return { category: 'pr', title: `PR #${next.number} merged`, body: clip(next.title), url, tag: `pr-${next.number}` }
  }
  if (next.checks.failed > 0 && prev && prev.checks.failed === 0) {
    return { category: 'pr', title: `Checks failed on PR #${next.number}`, body: clip(next.title), url, tag: `pr-${next.number}` }
  }
  return null
}

function sessionWhere(id: string): { kind: SessionKind; title?: string } {
  const cw = useCoworkSessions.getState().sessions.find((s) => s.id === id)
  if (cw) return { kind: 'cowork', title: cw.title }
  return { kind: 'chat', title: useThreads.getState().threads[id]?.title }
}

/** Starts asking for pushes; returns the function that stops it. */
export function startPushForwarding(emit: PushEmit): () => void {
  const send = (n: PushNotice) => emit({ type: 'push.notify', ...n })
  let roomStatus = useRoomsStore.getState().room?.status
  let journalLen = useRoomsStore.getState().journal.length
  let prs = new Map<string, PrLike>()
  const stops = [
    watchIds(
      useToolApprovalRequests,
      (s) => new Set(allApprovalRequests(s).map((a) => a.requestId)),
      ({ added }, s) => {
        const byId = new Map(allApprovalRequests(s).map((a) => [a.requestId, a]))
        for (const id of added) {
          const a = byId.get(id)
          if (a) send(approvalNotice(a, sessionWhere(a.threadId)))
        }
      }
    ),
    watchIds(
      useCoworkRun,
      (s) => new Set(asksIn(s.liveTurns).map((a) => `${a.threadId} ${a.requestId}`)),
      ({ added }) => {
        for (const key of added) {
          const threadId = key.split(' ')[0]
          send(askNotice(threadId, sessionWhere(threadId).title))
        }
      }
    ),
    watchIds(
      useCoworkRun,
      (s) => new Set(Object.keys(s.runs)),
      ({ removed }, s) => {
        for (const id of removed) {
          send(runEndNotice('cowork', id, sessionWhere(id).title, s.outcomes[id]))
        }
      }
    ),
    watchIds(
      useAppState,
      (s) => new Set(Object.entries(s.busyThreads).filter(([, b]) => b).map(([id]) => id)),
      ({ removed }) => removed.forEach((id) => send(runEndNotice('chat', id, sessionWhere(id).title, undefined)))
    ),
    useRoomsStore.subscribe((s) => {
      const room = s.room
      if (room && room.status !== roomStatus && room.status === 'awaiting-user') {
        send({ category: 'roomWaiting', title: 'A Room is waiting for you', body: clip(room.title), url: pushUrl('room', room.id), tag: `room-${room.id}` })
      }
      roomStatus = room?.status
      if (room && s.journal.length > journalLen) {
        const fresh = s.journal.slice(journalLen)
        if (fresh.some((r) => r.type === 'message' && r.message.kind === 'synthesis')) {
          send({ category: 'synthesis', title: 'Synthesis ready', body: clip(room.title), url: pushUrl('room', room.id), tag: `synthesis-${room.id}` })
        }
      }
      journalLen = s.journal.length
    }),
    usePrStatusStore.subscribe((s) => {
      const next = new Map<string, PrLike>()
      for (const [folder, entry] of Object.entries(s.byFolder)) {
        const l = entry.lookup
        if (l?.kind !== 'found') continue
        next.set(folder, l.pr)
        const n = prNotice(prs.get(folder), l.pr, coworkForFolder(folder))
        if (n) send(n)
      }
      prs = next
    }),
  ]
  return () => stops.forEach((stop) => stop())
}

function coworkForFolder(folder: string): string | null {
  const s = useCoworkSessions.getState().sessions.find((x) => x.folder === folder)
  return s?.id ?? null
}
