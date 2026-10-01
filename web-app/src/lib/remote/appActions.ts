// `RemoteActions` over the app's own stores and controllers: each action is
// the call the desktop's control makes, so a phone's action is recorded,
// permitted and shown exactly as the user's own would be.

import { useThreads } from '@/hooks/useThreads'
import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useWebSearchConfig } from '@/hooks/useWebSearchConfig'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import {
  allApprovalRequests,
  useToolApprovalRequests,
} from '@/hooks/useToolApprovalRequests'
import { useMessageQueue } from '@/stores/message-queue-store'
import { holdQueueThenStop } from '@/lib/chatSteering'
import { abortAll, abortRun } from '@/lib/coworkRunner'
import { roomController } from '@/lib/rooms/controller'
import { getRoomPersistence } from '@/lib/rooms/persistence'
import { useRoomsStore } from '@/lib/rooms/store'
import { describePermissionRequest } from '@/lib/permissionRequest'
import { resolveThreadModelId } from '@/lib/models'
import { SESSION_STORAGE_PREFIX } from '@/constants/chat'
import { route } from '@/constants/routes'
import { remoteApi } from './api'
import { RemoteRpcError } from './bridge'
import { composerFor, waitForComposer } from './composer'
import type { ApprovalScopeWire, RemoteActions } from './actions'
import type { ModelRef, NotificationPrefs } from './protocol'
import { resolveReplyModel } from '@/lib/resolveReplyModel'
import { useModelEvidence } from '@/hooks/useModelEvidence'
import { getLastUsedModel } from '@/utils/getModelToStart'

export type Navigate = (to: { to: string; params?: Record<string, string> }) => unknown

const SCOPE_WIRE = {
  'allow-once': 'once',
  'allow-thread': 'thread',
  'allow-always': 'always',
} as const

const NOTIFY_KEY = 'flint-remote-notification-prefs'

/** The chat composer's model-setting write (ChatInput `updateModelSetting`). */
function setModelSetting(model: ModelRef, key: string, title: string, value: unknown) {
  const store = useModelProvider.getState()
  const provider = store.getProviderByName(model.provider)
  if (!provider) return
  const index = provider.models.findIndex((m) => m.id === model.id)
  if (index === -1) return
  const current = provider.models[index]
  const existing = current.settings?.[key] ?? {
    key,
    title,
    description: '',
    controller_type: 'dropdown',
    controller_props: { value },
  }
  const updated = {
    ...current,
    settings: {
      ...current.settings,
      [key]: { ...existing, controller_props: { ...(existing.controller_props ?? {}), value } },
    },
  } as Model
  const models = [...provider.models]
  models[index] = updated
  store.updateProvider(model.provider, { models })
}

/** Emergency stop in the backend (CoworkStopMenu's `agent_emergency_stop`). */
async function backendStop(args: { session?: string; run?: string }) {
  if (!IS_TAURI) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('agent_emergency_stop', args).catch((e) =>
    console.warn('remote: emergency stop failed', e)
  )
}

export function appActions(navigate: Navigate): RemoteActions {
  const chatModelOf = (id: string): ModelRef | undefined => {
    const m = useThreads.getState().threads[id]?.model
    return m?.id && m.provider ? { id: m.id, provider: m.provider } : undefined
  }

  return {
    chatExists: (id) => Boolean(useThreads.getState().threads[id]),
    chatBusy: (id) => Boolean(useAppState.getState().busyThreads[id]),

    createChat: async ({ text, model }) => {
      const providers = useModelProvider.getState()
      // The phone's new chat names no model until one is chosen. Then the
      // computer picks the way its own composer does: the selected model, else
      // the default, the last used one, or whatever can answer.
      const fallback =
        model || providers.selectedModel
          ? undefined
          : resolveReplyModel({
              providers: providers.providers,
              preferred: useModelEvidence.getState().preferredModel,
              lastUsed: getLastUsedModel(),
            })
      const provider =
        model?.provider ?? fallback?.provider ?? providers.selectedProvider
      const modelId = resolveThreadModelId(
        provider,
        model?.id ?? fallback?.model ?? providers.selectedModel?.id,
        (providers.getProviderByName(provider)?.models ?? []).map((m) => m.id)
      )
      if (!provider || !modelId) {
        throw new RemoteRpcError(
          'unavailable',
          'No model is installed or connected on the computer to answer with.'
        )
      }
      const thread = await useThreads.getState().createThread({ id: modelId, provider }, text)
      // The first-message hand-off ChatInput uses: the conversation sends it
      // through its own path when it mounts.
      sessionStorage.setItem(
        `${SESSION_STORAGE_PREFIX.INITIAL_MESSAGE}${thread.id}`,
        JSON.stringify({ text, files: [] })
      )
      navigate({ to: route.threadsDetail, params: { threadId: thread.id } })
      return thread.id
    },

    setWebSearch: (on) => useWebSearchConfig.getState().setWebSearchEnabled(on),

    setChatReasoning: (chatId, mode, model) => {
      const target =
        model ??
        (chatId ? chatModelOf(chatId) : undefined) ??
        (() => {
          const s = useModelProvider.getState()
          return s.selectedModel ? { id: s.selectedModel.id, provider: s.selectedProvider } : undefined
        })()
      if (target) setModelSetting(target, 'reasoning', 'Reasoning', mode)
    },

    setChatModel: (chatId, model) => {
      const threads = useThreads.getState()
      threads.updateThread(chatId, { model })
    },

    coworkExists: (id) => useCoworkSessions.getState().sessions.some((s) => s.id === id),
    coworkBusy: (id) => Boolean(useCoworkRun.getState().runs[id]),
    knownFolders: () => [
      ...new Set(
        useCoworkSessions
          .getState()
          .sessions.flatMap((s) => (s.folder ? [s.folder] : []))
      ),
    ],

    createCowork: ({ folder, mode, model }) => {
      const store = useCoworkSessions.getState()
      const id = store.createSession()
      if (folder) store.setFolder(id, folder)
      if (mode) store.setMode(id, mode)
      if (model) store.setModel(id, model)
      return id
    },
    setCoworkMode: (id, mode) => useCoworkSessions.getState().setMode(id, mode),
    setCoworkModel: (id, model) => useCoworkSessions.getState().setModel(id, model),
    coworkAccess: (id) =>
      useCoworkSessions.getState().sessions.find((s) => s.id === id)?.access ?? null,
    setCoworkReviewOnly: async (id) => {
      // As the route's "Return to review-only": revoke, then record.
      await useDirectEditGrants.getState().revokeSession(id)
      useCoworkSessions.getState().setAccess(id, 'review-only')
    },

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

    sendViaComposer: async (kind, id, text) => {
      const entry = await waitForComposer(kind, id)
      if (!entry) return false
      await entry.send(text)
      return true
    },

    enqueue: (queueId, text, steer) =>
      useMessageQueue.getState().enqueue(queueId, {
        id: crypto.randomUUID(),
        text,
        createdAt: Date.now(),
        ...(steer ? { steer: true } : {}),
      }),

    stop: async (kind, id) => {
      if (kind === 'room') {
        if (!useRoomsStore.getState().runningRoomIds.includes(id)) return false
        await roomController.stop(id)
        return true
      }
      if (kind === 'chat') {
        if (!useAppState.getState().busyThreads[id]) return false
        const entry = composerFor('chat', id)
        if (!entry?.stop) return false
        entry.stop()
        return true
      }
      const run = useCoworkRun.getState().runs[id]
      if (!run) return false
      // CoworkStopMenu's "Stop current task": hold the queue, abort the loop,
      // then the scoped backend stop for the tools under it.
      holdQueueThenStop([id], () => abortRun(id))
      await backendStop({ session: id, run: run.runId })
      return true
    },

    stopAll: async () => {
      let count = 0
      holdQueueThenStop(Object.keys(useMessageQueue.getState().queues), () => {
        count = abortAll()
      })
      await backendStop({})
      return count
    },

    findApproval: (requestId) => {
      const entry = allApprovalRequests(useToolApprovalRequests.getState()).find(
        (a) => a.requestId === requestId
      )
      if (!entry) return null
      const scopes: ApprovalScopeWire[] = describePermissionRequest(entry).scopesOffered.map(
        (s) => SCOPE_WIRE[s]
      )
      return { toolCallId: entry.toolCallId, scopes }
    },

    resolveApproval: (toolCallId, requestId, decision) =>
      useToolApprovalRequests.getState().resolveApproval(toolCallId, decision, requestId),

    permissions: async () => {
      const status = await remoteApi.getStatus().catch(() => null)
      return status
        ? { approvals: status.config.allowApprovals, alwaysAllow: status.config.allowAlwaysAllow }
        : null
    },

    roomExists: async (id) => {
      if (useRoomsStore.getState().summaries.some((r) => r.id === id)) return true
      try {
        await getRoomPersistence().getRoom(id)
        return true
      } catch {
        return false
      }
    },

    room: {
      send: (id, text, to) => roomController.sendUserMessage(id, text, to),
      start: (id) => roomController.start(id),
      pause: (id) => roomController.pause(id),
      resume: (id) => roomController.resume(id),
      stop: (id) => roomController.stop(id),
      cancelTurn: (id) => roomController.cancelTurn(id),
      selectNext: (id, who) => roomController.selectNext(id, who),
      callVote: (id, proposal) => roomController.callVote(id, proposal),
      synthesize: (id) => roomController.synthesize(id),
      requestFinalPositions: (id) => roomController.requestFinalPositions(id),
    },

    setNotificationPrefs: (device, prefs) => writeNotificationPrefs(device, prefs),
  }
}

/** Per-phone notification choices, kept for the push notifications to come. */
export function readNotificationPrefs(device: string): NotificationPrefs | null {
  try {
    const all = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Record<string, NotificationPrefs>
    return all[device] ?? null
  } catch {
    return null
  }
}

function writeNotificationPrefs(device: string, prefs: NotificationPrefs) {
  try {
    const all = JSON.parse(localStorage.getItem(NOTIFY_KEY) ?? '{}') as Record<string, NotificationPrefs>
    all[device] = prefs
    localStorage.setItem(NOTIFY_KEY, JSON.stringify(all))
  } catch {
    // Storage unavailable: the phone keeps its own copy.
  }
}
