// The app's stores and services, as the remote handlers read them. Kept apart
// from the handlers so those stay testable with plain data.

import type { ThreadMessage } from '@janhq/core'
import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { getServiceHub } from '@/hooks/useServiceHub'
import { useRoomsStore } from '@/lib/rooms/store'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { isLocalProvider } from '@/lib/utils'
import { uiMessageText, type RemoteSources } from './handlers'
import type { RemoteMessage } from './protocol'

function threadMessageText(m: ThreadMessage): string {
  return (m.content ?? [])
    .map((c) => c.text?.value ?? '')
    .filter(Boolean)
    .join('\n')
}

const ms = (t: number) => (t < 1e12 ? Math.round(t * 1000) : t)

export const appSources: RemoteSources = {
  chats: () =>
    Object.values(useThreads.getState().threads).map((t) => {
      const project = t.metadata?.project as { name?: string } | undefined
      return {
        id: t.id,
        title: t.title,
        updated: t.updated,
        project: project?.name,
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

  approvals: () =>
    allApprovalRequests(useToolApprovalRequests.getState()).map((a) => ({
      requestId: a.requestId,
      threadId: a.threadId,
    })),

  chatMessages: async (id) => {
    if (!useThreads.getState().threads[id]) return []
    const messages = await getServiceHub().messages().fetchMessages(id)
    return messages.map(
      (m): RemoteMessage => ({
        id: m.id,
        role: m.role as RemoteMessage['role'],
        text: threadMessageText(m),
        createdAt: ms(m.created_at),
      })
    )
  },

  coworkMessages: (id) => {
    const session = useCoworkSessions.getState().sessions.find((s) => s.id === id)
    if (!session) return null
    return session.messages.map(
      (m): RemoteMessage => ({
        id: m.id,
        role: m.role as RemoteMessage['role'],
        text: uiMessageText(m),
        createdAt: session.updated,
      })
    )
  },

  roomMessages: async (id) => {
    const { journal } = await getRoomPersistence().getRoom(id)
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
            },
          ]
        : []
    )
  },

  providers: () =>
    useModelProvider
      .getState()
      .providers.filter((p) => p.active)
      .map((p) => ({
        provider: p.provider,
        local: Boolean(isLocalProvider(p.provider)),
        models: p.models
          .filter((m) => !m.embedding)
          .map((m) => ({ id: m.id, name: m.displayName ?? m.name })),
      })),

  loadedModels: async () => {
    try {
      return (await getServiceHub().models().getActiveModels()) ?? []
    } catch {
      return useAppState.getState().activeModels
    }
  },
}
