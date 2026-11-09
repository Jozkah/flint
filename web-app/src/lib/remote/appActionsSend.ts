// `RemoteActions` for opening a conversation and sending into it: the
// composer, attachments and the queue.

import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useMessageQueue } from '@/stores/message-queue-store'
import { useRoomsStore } from '@/lib/rooms/store'
import { route } from '@/constants/routes'
import { remoteApi } from './api'
import { composerFor, waitForComposer } from './composer'
import type { RemoteActions } from './actions'
import { useAttachments } from '@/hooks/useAttachments'
import { i18n } from '@/i18n/react-i18next-compat'
import { planAttachments } from './attachments'
import { stageComposerDocs, unstageComposerDocs } from './queuedSend'
import type { AppActionContext } from './appActionsShared'

export function sendActions(ctx: AppActionContext): Pick<
  RemoteActions,
  | 'open'
  | 'sendViaComposer'
  | 'prepareAttachments'
  | 'stageDocs'
  | 'enqueue'
> {
  const { navigate, chatModelOf } = ctx
  return {
    open: (kind, id) => {
      if (kind === 'room') {
        if (useRoomsStore.getState().currentRoomId !== id) {
          navigate({ to: route.roomDetail, params: { roomId: id } })
        }
        return
      }
      if (kind === 'chat') {
        if (useThreads.getState().currentThreadId === id && composerFor('chat', id)) return
        navigate({ to: route.threadsDetail, params: { threadId: id } })
        return
      }
      if (useCoworkSessions.getState().currentId !== id) {
        useCoworkSessions.getState().selectSession(id)
      }
      if (!composerFor('cowork', id)) navigate({ to: route.cowork })
    },

    sendViaComposer: async (kind, id, text, files) => {
      const entry = await waitForComposer(kind, id)
      if (!entry) {
        // No composer to send through: what the phone staged must not ride
        // along on the user's next send (P2D-016).
        unstageComposerDocs(kind, id)
        return false
      }
      // Unstaged even when the send throws, or the staged documents ride
      // along on the next, unrelated send.
      try {
        await entry.send(text, files)
      } finally {
        unstageComposerDocs(kind, id)
      }
      return true
    },

    prepareAttachments: async (deviceId, target, ids) => {
      const uploads = await remoteApi.takeUploads(deviceId, ids)
      const ref =
        target.model ??
        (target.id
          ? target.kind === 'chat'
            ? chatModelOf(target.id)
            : useCoworkSessions.getState().sessions.find((s) => s.id === target.id)?.model
          : undefined)
      const providers = useModelProvider.getState()
      const model = ref
        ? providers.getProviderByName(ref.provider)?.models.find((m) => m.id === ref.id)
        : providers.selectedModel
      const caps = model?.capabilities ?? []
      return planAttachments(
        uploads,
        { vision: caps.includes('vision'), audio: caps.includes('audio'), video: caps.includes('video') },
        (key) => i18n.t(key) as string,
        target.kind === 'cowork' ? 'inline' : useAttachments.getState().parseMode
      )
    },

    stageDocs: stageComposerDocs,

    enqueue: (queueId, text, steer, attachments) =>
      useMessageQueue.getState().enqueue(queueId, {
        id: crypto.randomUUID(),
        text,
        createdAt: Date.now(),
        ...(attachments && attachments.files.length + attachments.docs.length > 0
          ? { attachments }
          : steer
            ? { steer: true }
            : {}),
      }),
  }
}
