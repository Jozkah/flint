// `RemoteSources` for sessions: lists, what is running, and their messages.

import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useAppState } from '@/hooks/useAppState'
import { allApprovalRequests, useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import { useRoomsStore } from '@/lib/rooms/store'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { pageOf, uiMessageText, type RemoteSources } from './handlers'
import { coworkDetailOf, messageExtrasOf, roomDetailOf, toolStepsOf } from './details'
import { toMs } from '@/lib/messageTime'
import type { CoworkActivity, CoworkChanges, RemoteMessage } from './protocol'
import { useMessageQueue } from '@/stores/message-queue-store'
import { sessionPrStatuses, usePrStatusStore } from '@/stores/pr-status-store'
import { useCoworkWorktrees } from '@/hooks/useCoworkWorktrees'
import { collectCodeFileDiffs } from '@/lib/coworkDiffs'
import { formatChangeSummary } from '@/lib/coworkChangeSummary'
import { coworkReplyOf, roomReplyOf } from './events'
import { streamSnapshot } from './streams'
import { coworkToolStep } from './live'
import {
  coworkContextOf,
  MAX_HUNKS,
  MAX_HUNK_CHARS,
  snapshotOf,
  coworkTurnsOf,
  coworkEndingOf,
  chatActivePath,
  speakerOf,
} from './sessionViews'

/** Sessions: lists, what is running, and their messages. */
export const sessionSources: Pick<RemoteSources, 'chats' | 'coworkSessions' | 'rooms' | 'running' | 'chatMessages' | 'chatMessagesPage' | 'coworkMessages' | 'roomMessages' | 'roomDetail' | 'coworkDetail' | 'streamSnapshot' | 'queue' | 'coworkChanges' | 'coworkActivity'> = {
  chats: () =>
    Object.values(useThreads.getState().threads).map((t) => {
      const project = t.metadata?.project as { name?: string } | undefined
      return {
        id: t.id,
        title: t.title,
        updated: t.updated,
        project: project?.name,
        pinned: Boolean(t.isFavorite),
      }
    }),
  coworkSessions: () =>
    useCoworkSessions.getState().sessions.map((s) => ({
      id: s.id,
      title: s.title,
      updated: s.updated,
      folder: s.folder,
    })),
  rooms: async () => {
    const cached = useRoomsStore.getState().summaries
    const summaries = cached.length ? cached : await getRoomPersistence().listRooms()
    return summaries.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      updatedAt: r.updatedAt,
    }))
  },
  running: () => ({
    chat: new Set(
      Object.entries(useAppState.getState().busyThreads)
        .filter(([, busy]) => busy)
        .map(([id]) => id)
    ),
    cowork: new Set(Object.keys(useCoworkRun.getState().runs)),
    room: new Set(useRoomsStore.getState().runningRoomIds),
  }),
  chatMessages: async (id) => {
    const path = await chatActivePath(id)
    return path ? path.messages.map(path.convert) : []
  },
  chatMessagesPage: async (id, before, limit) => {
    const path = await chatActivePath(id)
    if (!path) return { items: [], start: 0, total: 0 }
    // Only the page is converted: a long chat's older messages stay untouched.
    const { items, start, total } = pageOf(path.messages, before, limit)
    return { items: items.map(path.convert), start, total }
  },
  coworkMessages: (id) => {
    const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
    if (!session) return null
    const awaiting = new Set(
      allApprovalRequests(useToolApprovalRequests.getState())
        .filter((a) => a.threadId === id)
        .map((a) => a.toolCallId)
    )
    return session.messages.map((m): RemoteMessage => {
      const tools = m.role === 'assistant' ? toolStepsOf(m, awaiting) : []
      return {
        id: m.id,
        role: m.role as RemoteMessage['role'],
        text: uiMessageText(m),
        // Each message keeps its stored time; old rows without one fall back
        // to the session's last change.
        createdAt: toMs((m.metadata as { createdAt?: unknown } | undefined)?.createdAt) ?? session.updated,
        ...(tools.length ? { tools } : {}),
        ...messageExtrasOf(m),
      }
    })
  },
  roomMessages: async (id) => {
    const { room, journal } = await getRoomPersistence().getRoom(id)
    return journal.flatMap((r): RemoteMessage[] =>
      r.type === 'message'
        ? [
            {
              id: r.message.id,
              role: r.message.author.kind === 'user' ? 'user' : 'assistant',
              text: r.message.text,
              createdAt: r.message.createdAt,
              author:
                'name' in r.message.author ? r.message.author.name : undefined,
              ...('participantId' in r.message.author
                ? speakerOf(room, r.message.author.participantId)
                : {}),
            },
          ]
        : []
    )
  },
  roomDetail: async (id) => {
    try {
      const { room } = await getRoomPersistence().getRoom(id)
      return roomDetailOf(room)
    } catch {
      return null
    }
  },
  coworkDetail: (id) => {
    const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
    if (!session) return null
    const context = coworkContextOf(session)
    const ending = coworkEndingOf(session)
    return { ...coworkDetailOf(session), ...(context ? { context } : {}), ...(ending ? { ending } : {}) }
  },
  streamSnapshot: (kind, id) =>
    kind === 'cowork'
      ? snapshotOf(kind, id, coworkReplyOf(id))
      : kind === 'room'
        ? snapshotOf(kind, id, roomReplyOf(id))
        : streamSnapshot(kind, id),
  queue: (id) =>
    useMessageQueue
      .getState()
      .getQueue(id)
      .map((m) => ({
        id: m.id,
        text: m.text,
        steer: Boolean(m.steer),
        held: Boolean(m.held),
        ...(m.from ? { from: m.from.displayName } : {}),
      })),
  coworkChanges: (id): CoworkChanges | null => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const { session, turns, subagents, running } = found
    const diffs = collectCodeFileDiffs(turns, subagents)
    const counts = {
      fileCount: diffs.length,
      additions: diffs.reduce((n, d) => n + d.additions, 0),
      deletions: diffs.reduce((n, d) => n + d.deletions, 0),
    }
    const tree = useCoworkWorktrees.getState().bySession[id]
    const prs = usePrStatusStore.getState()
    const pr = sessionPrStatuses(prs.sessionPrs[id] ?? [], prs.byUrl)[0]
    return {
      files: diffs.map((d) => ({
        path: d.path,
        additions: d.additions,
        deletions: d.deletions,
        source: [...new Set(d.operations.map((o) => o.sourceName ?? o.source))].join(', '),
        hunks: d.operations.slice(-MAX_HUNKS).map((o) => o.diff.slice(0, MAX_HUNK_CHARS)),
      })),
      // As the desktop's What changed row: only once a run has finished.
      summary: !running && diffs.length ? formatChangeSummary(counts) : null,
      worktree: tree ? { branch: tree.kind === 'copy' ? null : tree.branch, path: tree.path } : null,
      pr: pr
        ? {
            number: pr.number,
            title: pr.title,
            url: pr.url,
            state: pr.state,
            checks: pr.checks,
            conflicts: pr.merge === 'conflicting',
          }
        : null,
      applyOnDesktop: diffs.length > 0 && (session.access ?? 'review-only') === 'review-only',
    }
  },
  coworkActivity: (id): CoworkActivity | null => {
    const found = coworkTurnsOf(id)
    if (!found) return null
    const commands = found.turns.flatMap((t) => {
      if (t.role !== 'tool' || (t.name !== 'bash' && t.name !== 'shell')) return []
      const step = coworkToolStep(t, new Set())
      return step ? [{ id: step.id, command: step.arg ?? step.name, status: step.status }] : []
    })
    return {
      subagents: found.subagents.map((r) => ({
        id: r.runId,
        name: r.name,
        status: r.status,
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        steps: r.turns.filter((t) => t.role === 'tool').length,
      })),
      commands: commands.slice(-50),
    }
  },
}
