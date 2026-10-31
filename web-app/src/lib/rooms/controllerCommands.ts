/**
 * The room controller's commands, grouped: run control, the room editor and
 * housekeeping. `createRoomController` builds one `ControllerContext` (the
 * per-room queue, run slots, persistence and store) and merges the groups.
 */
import { clearRoomScratch, clearsKnowledge, clearsScratch } from './clearRoom'
import type { AbortIntent, RunCommand } from './engine'
import { clearSuspensions } from './availability'
import { parseAddress } from './addressing'
import { checkLimits, clampLimits, emptyUsage, extendedLimits } from './limits'
import { activeParticipants } from './policy'
import type { RoomPersistence } from './persistence'
import type { useRoomsStore } from './store'
import type { RoomWorkspaceDeps } from './isolation'
import { useToolApprovalRequests } from '@/hooks/useToolApprovalRequests'
import {
  budgetField,
  cleanDisabledTools,
  cleanExtraFolders,
  normaliseModerator,
  normaliseParticipant,
  roomEffortField,
  roomError,
  validateParticipants,
} from './participants'
import {
  DEFAULT_ROOM_LIMITS,
  ROOM_SCHEMA_VERSION,
  type Address,
  type Room,
  type RoomMessage,
} from './types'
import type { RoomControllerApi, RoomSlot } from './controller'
import type { ProviderLookup } from './availability'

/** What every command group shares, built once per controller. */
export type ControllerContext = {
  persistence: () => RoomPersistence
  store: () => ReturnType<typeof useRoomsStore.getState>
  now: () => number
  newId: () => string
  slot: (roomId: string) => RoomSlot
  slots: Map<string, RoomSlot>
  enqueue: <T>(roomId: string, op: () => Promise<T>) => Promise<T>
  saveRoom: (room: Room) => Promise<Room>
  appendMessage: (roomId: string, message: RoomMessage) => Promise<void>
  userMessage: (
    roomId: string,
    round: number,
    text: string,
    to: Address
  ) => RoomMessage
  launch: (
    roomId: string,
    command: RunCommand,
    guard?: (room: Room) => boolean
  ) => Promise<void>
  abortRun: (roomId: string, intent: AbortIntent) => Promise<boolean>
  guarded: (action: string, op: () => Promise<void>) => Promise<void>
  setStatusWhenIdle: (
    roomId: string,
    decide: (room: Room) => Partial<Room> | null
  ) => Promise<void>
  refuseWhileRunning: (room: Room) => void
  participantDeps: { newId: () => string; lookup: ProviderLookup }
  workspace: RoomWorkspaceDeps
}

/**
 * Whether a user message should make a non-running room pick up and respond,
 * rather than only be recorded. Paused, awaiting-user, completed and
 * user/converged-stopped rooms resume -- but only when continuing would not
 * immediately hit a limit. A room at (or past) a limit is left as it is so the
 * composer can offer to extend it (see `extendLimit`); otherwise it would
 * resume and re-stop in the same instant, swallowing the message.
 */
export function canResumeOnMessage(room: Room, now: number): boolean {
  switch (room.status) {
    case 'paused':
    case 'awaiting-user':
    case 'completed':
    case 'stopped':
      break
    default:
      return false
  }
  // The single source of truth for "would continuing help": if no limit blocks,
  // resume; if one does, leave it for the composer's extend prompt. Keying off
  // stopReason instead would strand a limit-stopped room whose limit the user
  // has since raised in the editor -- the message would be swallowed.
  return (
    checkLimits(room, now, {
      activeSince: now,
      callsMade: 0,
      speaking: true,
    }) === null
  )
}

/** Run control: start, pause, stop, messages and engine commands. */
export function runCommands(
  ctx: ControllerContext
): Pick<
  RoomControllerApi,
  | 'isRunning'
  | 'whenIdle'
  | 'start'
  | 'resume'
  | 'pause'
  | 'stop'
  | 'cancelTurn'
  | 'selectNext'
  | 'sendUserMessage'
  | 'extendLimit'
  | 'callVote'
  | 'compareRun'
  | 'requestFinalPositions'
  | 'synthesize'
> {
  const {
    persistence,
    now,
    slot,
    enqueue,
    saveRoom,
    appendMessage,
    userMessage,
    launch,
    abortRun,
    guarded,
    setStatusWhenIdle,
  } = ctx
  return {
    isRunning: (roomId) => !!slot(roomId).run,
    whenIdle: async (roomId) => {
      const s = slot(roomId)
      let seen: Promise<void> | null = null
      while (seen !== s.chain) {
        seen = s.chain
        await seen
      }
    },

    start: (roomId) =>
      guarded('start', async () => {
        void launch(
          roomId,
          { kind: 'discuss' },
          (room) => room.status !== 'running'
        )
      }),

    resume: (roomId) =>
      guarded('resume', async () => {
        void launch(
          roomId,
          { kind: 'discuss' },
          (room) => room.status === 'paused' || room.status === 'awaiting-user'
        )
      }),

    pause: (roomId) =>
      guarded('pause', async () => {
        if (await abortRun(roomId, 'pause')) return
        await setStatusWhenIdle(roomId, (room) =>
          room.status === 'running' || room.status === 'awaiting-user'
            ? { status: 'paused', stopReason: { kind: 'user' } }
            : null
        )
      }),

    stop: (roomId) =>
      guarded('stop', async () => {
        slot(roomId).stops += 1
        if (await abortRun(roomId, 'stop')) return
        await setStatusWhenIdle(roomId, (room) =>
          room.status === 'stopped' ||
          room.status === 'completed' ||
          room.status === 'draft'
            ? null
            : { status: 'stopped', stopReason: { kind: 'user' } }
        )
      }),

    cancelTurn: (roomId) =>
      guarded('cancelTurn', async () => {
        await abortRun(roomId, 'cancel-turn')
      }),

    selectNext: (roomId, participantId) =>
      guarded('selectNext', async () => {
        const s = slot(roomId)
        if (s.run) {
          s.override = participantId
          return
        }
        let continueRoom = false
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          const target = activeParticipants(room).find(
            (p) => p.id === participantId
          )
          if (!target) {
            throw roomError(
              'invalid_room',
              'That participant cannot speak now.'
            )
          }
          await saveRoom({ ...room, nextSpeakerId: participantId })
          continueRoom =
            room.mode === 'user-selected' && room.status === 'awaiting-user'
        })
        if (continueRoom) void launch(roomId, { kind: 'discuss' })
      }),

    sendUserMessage: (roomId, text, to) =>
      guarded('sendUserMessage', async () => {
        const body = text.trim()
        if (!body) throw roomError('invalid_room', 'The message is empty.')
        const s = slot(roomId)
        if (s.run) {
          s.userQueue.push({ text: body, to })
          return
        }
        // Whether the room should pick the message up and act on it, rather than
        // just record it. A room stopped by a limit is left alone: resuming it
        // would only re-trip the same limit, so the UI offers to extend instead.
        let resume = false
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          const address =
            to.kind === 'room'
              ? parseAddress(
                  body,
                  room.participants,
                  room.moderator.enabled ? room.moderator.name : null
                )
              : to
          await appendMessage(
            roomId,
            userMessage(roomId, room.round, body, address)
          )
          // In user-selected mode the room waits for the user to pick who speaks
          // next, so a message only resumes when it names a participant (that one
          // answers); a message to everyone/moderator leaves the room waiting.
          if (
            room.mode === 'user-selected' &&
            room.status === 'awaiting-user'
          ) {
            if (address.kind === 'participant') {
              await saveRoom({ ...room, nextSpeakerId: address.participantId })
              resume = true
            }
            return
          }
          resume = canResumeOnMessage(room, now())
        })
        if (resume)
          void launch(
            roomId,
            { kind: 'discuss' },
            (room) => room.status !== 'running'
          )
      }),

    extendLimit: (roomId, addRounds, text, to) =>
      guarded('extendLimit', async () => {
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          // Raise every limit together so the room can actually run the extra
          // rounds -- extending one limit by a small count re-trips instantly on
          // the token/time/cost limits or on whatever limit is next.
          const limits = extendedLimits(room, addRounds)
          await saveRoom({ ...room, limits, stopReason: null })
          const body = text?.trim()
          if (body && to) {
            const address =
              to.kind === 'room'
                ? parseAddress(
                    body,
                    room.participants,
                    room.moderator.enabled ? room.moderator.name : null
                  )
                : to
            await appendMessage(
              roomId,
              userMessage(roomId, room.round, body, address)
            )
          }
        })
        void launch(
          roomId,
          { kind: 'discuss' },
          (room) => room.status !== 'running'
        )
      }),

    callVote: (roomId, proposal) =>
      guarded('callVote', async () => {
        const text = proposal.trim()
        if (!text) throw roomError('invalid_room', 'The proposal is empty.')
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'vote', proposal: text })
      }),

    compareRun: (roomId, participantIds, scope) =>
      guarded('compareRun', async () => {
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'compare-run', participantIds, scope })
      }),

    requestFinalPositions: (roomId) =>
      guarded('requestFinalPositions', async () => {
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'final-positions' })
      }),

    synthesize: (roomId) =>
      guarded('synthesize', async () => {
        await abortRun(roomId, 'pause')
        void launch(roomId, { kind: 'synthesize' })
      }),
  }
}

/** Room editor: create a room, change settings and participants. */
export function editorCommands(
  ctx: ControllerContext
): Pick<
  RoomControllerApi,
  'createRoom' | 'updateRoomSettings' | 'addParticipant' | 'removeParticipant'
> {
  const {
    persistence,
    now,
    newId,
    enqueue,
    saveRoom,
    refuseWhileRunning,
    participantDeps,
  } = ctx
  return {
    createRoom: async (input) => {
      const title = input.title.trim()
      if (!title) throw roomError('invalid_room', 'A room needs a title.')
      const participants = (input.participants ?? []).map((p, i) =>
        normaliseParticipant({ ...p, order: i }, participantDeps)
      )
      validateParticipants(participants)
      const t = now()
      const room: Room = {
        v: ROOM_SCHEMA_VERSION,
        id: newId(),
        title: title.slice(0, 200),
        objective: (input.objective ?? '').trim(),
        status: 'draft',
        mode: input.mode ?? 'round-robin',
        ...(input.compareRun === 'one-by-one'
          ? { compareRun: 'one-by-one' as const }
          : {}),
        moderator: normaliseModerator(input.moderator),
        participants,
        limits: clampLimits({
          ...DEFAULT_ROOM_LIMITS,
          ...(input.limits ?? {}),
        }),
        usage: emptyUsage(),
        round: 0,
        spokenThisRound: [],
        nextSpeakerId: null,
        stopReason: null,
        rev: 0,
        createdAt: t,
        updatedAt: t,
      }
      return saveRoom(room)
    },

    // The editor passes the Room it rendered. Each edit re-reads the stored
    // room inside the queue, like selectNext and extendLimit do, so a second
    // edit queued behind the first builds on its result instead of saving
    // against the old rev and failing with stale_revision (#219).
    updateRoomSettings: async (shown, patch) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        let participants = room.participants
        for (const edit of patch.participants ?? []) {
          const idx = edit.id
            ? participants.findIndex((p) => p.id === edit.id)
            : -1
          if (idx < 0) {
            if (!edit.name || !edit.model) {
              throw roomError(
                'invalid_room',
                'A new participant needs a name and a model.'
              )
            }
            const order = participants.reduce(
              (m, p) => Math.max(m, p.order + 1),
              0
            )
            participants = [
              ...participants,
              normaliseParticipant(
                {
                  name: edit.name,
                  role: edit.role,
                  model: edit.model,
                  toolAccess: edit.toolAccess,
                  pricing: edit.pricing,
                  reasoning: edit.reasoning ?? undefined,
                  order: edit.order ?? order,
                },
                participantDeps
              ),
            ]
            continue
          }
          const prev = participants[idx]
          const next = normaliseParticipant(
            {
              id: prev.id,
              name: edit.name ?? prev.name,
              role: edit.role ?? prev.role,
              model: edit.model ?? prev.model,
              toolAccess: edit.toolAccess ?? prev.toolAccess,
              pricing: edit.pricing === undefined ? prev.pricing : edit.pricing,
              reasoning:
                edit.reasoning === undefined
                  ? prev.reasoning
                  : (edit.reasoning ?? undefined),
              assistantId:
                edit.assistantId === undefined
                  ? prev.assistantId
                  : edit.assistantId,
              workProfile:
                edit.workProfile === undefined
                  ? prev.workProfile
                  : edit.workProfile,
              order: edit.order ?? prev.order,
              removed: prev.removed,
            },
            participantDeps
          )
          const skip = edit.compareSkip ?? prev.compareSkip
          if (skip) next.compareSkip = true
          const off = cleanDisabledTools(
            edit.disabledTools === undefined
              ? prev.disabledTools
              : edit.disabledTools
          )
          if (off.length) next.disabledTools = off
          participants = participants.map((p, i) => (i === idx ? next : p))
        }
        validateParticipants(participants)
        const updated: Room = {
          ...room,
          title:
            typeof patch.title === 'string'
              ? patch.title.trim().slice(0, 200) || room.title
              : room.title,
          objective:
            patch.objective !== undefined
              ? patch.objective.trim()
              : room.objective,
          mode: patch.mode ?? room.mode,
          ...(patch.compareRun === 'one-by-one' ||
          (patch.compareRun === undefined && room.compareRun === 'one-by-one')
            ? { compareRun: 'one-by-one' as const }
            : { compareRun: undefined }),
          moderator: patch.moderator
            ? normaliseModerator(patch.moderator, room.moderator)
            : room.moderator,
          folder:
            patch.folder !== undefined
              ? patch.folder || null
              : (room.folder ?? null),
          extraFolders: cleanExtraFolders(
            patch.extraFolders !== undefined
              ? patch.extraFolders
              : (room.extraFolders ?? []),
            patch.folder !== undefined
              ? patch.folder || null
              : (room.folder ?? null)
          ),
          ...budgetField(
            patch.toolBudget === undefined ? room.toolBudget : patch.toolBudget
          ),
          reasoningEffort: roomEffortField(
            patch.reasoningEffort === undefined
              ? room.reasoningEffort
              : patch.reasoningEffort
          ),
          limits: clampLimits({ ...room.limits, ...(patch.limits ?? {}) }),
          // Raising a limit that stopped the room clears the stop, so a message
          // resumes it instead of being stranded by a limit that no longer binds.
          stopReason:
            patch.limits && room.stopReason?.kind === 'limit'
              ? null
              : room.stopReason,
          participants,
        }
        return saveRoom(updated)
      })
    },

    addParticipant: async (shown, input) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        const order = room.participants.reduce(
          (m, p) => Math.max(m, p.order + 1),
          0
        )
        const participants = [
          ...room.participants,
          normaliseParticipant({ ...input, order }, participantDeps),
        ]
        validateParticipants(participants)
        return saveRoom({ ...room, participants })
      })
    },

    removeParticipant: async (shown, participantId) => {
      refuseWhileRunning(shown)
      return enqueue(shown.id, async () => {
        const { room } = await persistence().getRoom(shown.id)
        refuseWhileRunning(room)
        if (!room.participants.some((p) => p.id === participantId)) {
          throw roomError('invalid_room', 'Unknown participant.')
        }
        return saveRoom({
          ...room,
          participants: room.participants.map((p) =>
            p.id === participantId ? { ...p, removed: true } : p
          ),
          spokenThisRound: room.spokenThisRound.filter(
            (id) => id !== participantId
          ),
          nextSpeakerId:
            room.nextSpeakerId === participantId ? null : room.nextSpeakerId,
        })
      })
    },
  }
}

/** Room housekeeping: change decisions, clearing and deleting. */
export function roomCommands(
  ctx: ControllerContext
): Pick<RoomControllerApi, 'setChangeDecision' | 'clearRoom' | 'deleteRoom'> {
  const {
    persistence,
    store,
    slot,
    slots,
    enqueue,
    saveRoom,
    abortRun,
    guarded,
    workspace,
  } = ctx
  return {
    setChangeDecision: (roomId, messageId, decision) =>
      guarded('change-decision', async () => {
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          await saveRoom({
            ...room,
            changeDecisions: {
              ...(room.changeDecisions ?? {}),
              [messageId]: decision,
            },
          })
        })
      }),

    clearRoom: (roomId, scope) =>
      guarded('clear', async () => {
        if (slot(roomId).run) {
          throw roomError(
            'invalid_room',
            'Pause or stop the room before clearing it.'
          )
        }
        await enqueue(roomId, async () => {
          const { room } = await persistence().getRoom(roomId)
          if (room.status === 'running') {
            throw roomError(
              'invalid_room',
              'Pause or stop the room before clearing it.'
            )
          }
          await persistence().clearRoomJournal(roomId)
          let next: Room = {
            ...room,
            status: 'draft',
            round: 0,
            spokenThisRound: [],
            nextSpeakerId: null,
            stopReason: null,
          }
          if (clearsKnowledge(scope)) {
            next = { ...clearSuspensions(next), usage: emptyUsage() }
          }
          // Decisions name messages that are gone now.
          if (next.changeDecisions)
            next = { ...next, changeDecisions: undefined }
          await saveRoom(next)
        })
        if (clearsScratch(scope)) {
          await clearRoomScratch(roomId)
          // Only "clear everything" drops the isolated workspaces and the
          // changes waiting in them; a chat or knowledge clear keeps them.
          await workspace.remove?.(roomId).catch(() => {})
        }
        await store().loadRoom(roomId)
      }),

    deleteRoom: async (roomId, opts) => {
      useToolApprovalRequests.getState().expireHeld(roomId)
      await abortRun(roomId, 'stop')
      await enqueue(roomId, async () => {
        const port = persistence()
        if (opts?.permanent && port.deleteRoomPermanently) {
          await port.deleteRoomPermanently(roomId)
        } else {
          await port.deleteRoom(roomId)
        }
      })
      slots.delete(roomId)
      store().removeRoomLocally(roomId)
    },
  }
}
