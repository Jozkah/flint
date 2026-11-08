import type { StateCreator } from 'zustand'
import { coworkTurnsToUIMessages } from '@/lib/coworkTurns'
import {
  decideSessionStart,
  DEFAULT_SESSION_TITLE,
  isSessionEmpty,
} from '@/lib/coworkSessionStart'
import { useFileActivity } from '@/hooks/useFileActivity'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import {
  checkBundle,
  importedFileActivity,
  importedTurns,
} from '@/lib/sessionBundle'
import { importedUsage } from '@/lib/coworkSessionStamps'
import { deletePromptSnapshots } from '@/lib/promptSnapshotRetention'
import type { CoworkSession, CoworkSessionsState } from './types'

const now = () => Date.now()

export type LifecycleSlice = Pick<
  CoworkSessionsState,
  | 'createSession'
  | 'startSession'
  | 'startSessionParked'
  | 'selectSession'
  | 'forkSession'
  | 'createFromTurns'
  | 'dismissHandoff'
  | 'importSession'
  | 'restoreSession'
  | 'deleteSession'
>

export const createLifecycleSlice: StateCreator<
  CoworkSessionsState,
  [['zustand/persist', unknown]],
  [],
  LifecycleSlice
> = (set, get) => ({
  createSession: () => {
    const id = crypto.randomUUID()
    const session: CoworkSession = {
      id,
      title: DEFAULT_SESSION_TITLE,
      folder: null,
      turns: [],
      messages: [],
      updated: now(),
      createdAt: now(),
    }
    // Starting a new one leaves any blank session behind it: a blank
    // holds nothing, so keeping it only lengthens the list.
    set((s) => ({
      sessions: dropBlanks([session, ...s.sessions], id),
      currentId: id,
    }))
    return id
  },

  startSession: (input) => get().startSessionParked(input).id,

  startSessionParked: ({ running, draft }) => {
    const state = get()
    const current = state.sessions.find((s) => s.id === state.currentId)
    // Asked here rather than at each call site so every entry point to
    // "New session" judges emptiness the same way.
    const hasFileActivity = current
      ? useFileActivity.getState().eventsFor(current.id).length > 0
      : false
    if (
      current &&
      decideSessionStart({ current, running, hasFileActivity }) === 'reuse'
    ) {
      // Blank: this is already the new session, and a draft typed in it
      // belongs there. Parking it on a blank session hid it (blanks are
      // hidden from the list) and wiped the composer.
      return { id: current.id, parked: false }
    }
    // The caller supplies the draft from the composer it owns.
    const parked = Boolean(current && draft?.trim())
    if (current && parked) {
      get().setPendingInput(current.id, [
        ...(current.pendingInput ?? []),
        {
          id: crypto.randomUUID(),
          text: draft as string,
          createdAt: Date.now(),
        },
      ])
    }
    return { id: get().createSession(), parked }
  },

  // Leaving a blank session discards it, so pressing New session and then
  // going back to an older one does not leave an empty entry behind.
  selectSession: (id) =>
    set((s) => ({ sessions: dropBlanks(s.sessions, id), currentId: id })),

  forkSession: (id, throughTurn) => {
    const parent = get().sessions.find((x) => x.id === id)
    // No session, or a divergence point outside the conversation. Refused
    // rather than clamped: a fork silently taken at a different turn than
    // the one asked for is not the thing the user asked for.
    if (!parent) return null
    const keep = throughTurn ?? parent.turns.length
    if (!Number.isInteger(keep) || keep < 0 || keep > parent.turns.length) {
      return null
    }

    const turns = parent.turns.slice(0, keep)
    const forkId = crypto.randomUUID()
    const fork: CoworkSession = {
      id: forkId,
      title: parent.title ? `${parent.title} (fork)` : 'New session',
      turns,
      // Rebuilt from the kept turns rather than sliced from the parent's
      // messages: the two arrays do not correspond one to one, and a
      // message array cut at the wrong index sends the model half a turn.
      messages: coworkTurnsToUIMessages(turns, forkId),
      /*
       * Nothing that grants anything is copied.
       *
       * A fork starts unbound: no folder, no write grant, no edit consent,
       * no worktree, no access mode. Inheriting them would let a user
       * multiply the authority they were given once by forking, and would
       * point two sessions at one checkout without either knowing.
       */
      folder: null,
      // Bypass is never inherited: it is written to disk as `ask`, so a
      // fork that kept it would change meaning after a restart.
      mode: parent.mode === 'bypass' ? 'ask' : parent.mode,
      todos: parent.todos,
      goal: parent.goal,
      forkedFrom: { sessionId: parent.id, turns: keep, at: now() },
      updated: now(),
    }

    set((s) => ({ sessions: [fork, ...s.sessions], currentId: forkId }))
    return forkId
  },

  createFromTurns: (title, turns) => {
    const id = crypto.randomUUID()
    const session: CoworkSession = {
      id,
      title: title.trim() || DEFAULT_SESSION_TITLE,
      folder: null,
      turns,
      messages: coworkTurnsToUIMessages(turns, id),
      updated: now(),
      createdAt: now(),
    }
    set((s) => ({ sessions: [session, ...s.sessions], currentId: id }))
    return id
  },

  dismissHandoff: (id) =>
    set((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === id && x.handoff
          ? { ...x, handoff: { ...x.handoff, dismissed: true } }
          : x
      ),
    })),

  importSession: (bundle, handoff) => {
    const problem = checkBundle(bundle)
    if (problem) {
      return { ok: false, refusal: { reason: 'invalid', message: problem } }
    }
    const existing = get().sessions.find(
      (x) => x.importedFrom?.exportId === bundle.exportId
    )
    if (existing) {
      return {
        ok: false,
        refusal: { reason: 'already-imported', sessionId: existing.id },
      }
    }
    const id = crypto.randomUUID()
    const turns = importedTurns(bundle.session.turns, id)
    const session: CoworkSession = {
      id,
      title: bundle.session.title || 'Imported session',
      turns,
      messages: coworkTurnsToUIMessages(turns, id),
      subagents: bundle.session.subagents,
      // Unbound, like a fork: the export carried no authority and this
      // machine has granted none.
      folder: null,
      mode: bundle.session.mode === 'bypass' ? 'ask' : bundle.session.mode,
      goal: bundle.session.goal,
      todos: bundle.session.todos,
      forkedFrom: bundle.session.forkedFrom,
      // Re-read rather than trusted: a hand-edited file cannot plant a
      // negative, a string or a cached count larger than the input.
      lastUsage: importedUsage(bundle.session.lastUsage),
      importedFrom: {
        exportId: bundle.exportId,
        sessionId: bundle.session.id,
        at: now(),
      },
      handoff,
      updated: now(),
    }
    set((s) => ({ sessions: [session, ...s.sessions], currentId: id }))
    const events = importedFileActivity(bundle.fileActivity ?? [], id)
    if (events.length) useFileActivity.getState().record(id, events)
    return { ok: true, id }
  },

  restoreSession: (session) => {
    if (get().sessions.some((x) => x.id === session.id)) return false
    set((s) => ({
      sessions: [session, ...s.sessions],
      currentId: session.id,
    }))
    return true
  },

  deleteSession: (id, opts) =>
    set((s) => {
      if (!opts?.keepRecords) void deletePromptSnapshots(id)
      const sessions = s.sessions.filter((x) => x.id !== id)
      const currentId =
        s.currentId === id ? (sessions[0]?.id ?? null) : s.currentId
      return { sessions, currentId }
    }),
})

/**
 * The sessions without the blank ones, except `keepId`. A session with a run
 * going, file activity or held input is not blank, whatever its turns say.
 */
function dropBlanks(sessions: CoworkSession[], keepId: string): CoworkSession[] {
  const runs = useCoworkRun.getState().runs ?? {}
  const files = useFileActivity.getState()
  const next = sessions.filter(
    (s) =>
      s.id === keepId ||
      !isSessionEmpty(s) ||
      s.title !== DEFAULT_SESSION_TITLE ||
      Boolean(runs[s.id]) ||
      (s.pendingInput?.length ?? 0) > 0 ||
      files.eventsFor(s.id).length > 0
  )
  return next.length === sessions.length ? sessions : next
}
