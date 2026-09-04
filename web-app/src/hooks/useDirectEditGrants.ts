import { create } from 'zustand'
import {
  directEditAuthorize,
  directEditCapability,
  directEditRevoke,
  directEditRevokeSession,
} from '@janhq/tauri-plugin-agent-tools-api'
import type { LiveGrant } from '@/lib/coworkAccess'

/**
 * The grants this renderer believes the backend is holding.
 *
 * Deliberately not persisted, and the omission is the design. The backend keeps
 * its grants in process memory, so a restart leaves it holding none; if this
 * store wrote them to disk, a restored session would show "editable" while
 * nothing could actually be written, which is the class of false claim this
 * whole rework exists to remove. Restarting therefore returns every session to
 * Review only until the user confirms again — not by a cleanup step that could
 * be forgotten, but because there is nowhere for the id to have survived.
 *
 * Grant ids are authority-bearing even though they are opaque. They stay in
 * this store and in the command arguments of the run that owns them: never in a
 * prompt, a message, an activity row, or anything shown to a user.
 */

export type CapabilityState =
  /** Not asked yet, or the answer has not arrived. */
  | { known: false; reason: 'loading' }
  /** The query failed. Not permission — the absence of an answer. */
  | { known: false; reason: 'failed'; message: string }
  | { known: true; directEdit: boolean }

export type AuthorizeOutcome =
  | { ok: true; grant: LiveGrant }
  | { ok: false; reason: string }

type DirectEditGrantsState = {
  capability: CapabilityState
  /** Live grants, by the session each was issued to. */
  bySession: Record<string, LiveGrant>
  /**
   * Bumped whenever a request is superseded, so a reply that arrives after the
   * user moved on can be recognised as belonging to a question nobody is
   * waiting on any more.
   */
  generation: number

  refreshCapability: () => Promise<void>
  authorize: (
    sessionId: string,
    folder: string,
    dataFolder: string
  ) => Promise<AuthorizeOutcome>
  /** Withdraw this session's grant, backend first. */
  revokeSession: (sessionId: string) => Promise<boolean>
  grantFor: (sessionId: string | null | undefined) => LiveGrant | undefined
  /** Drop local state without calling the backend, when it is already gone. */
  forget: (sessionId: string) => void
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)

export const useDirectEditGrants = create<DirectEditGrantsState>()(
  (set, get) => ({
    capability: { known: false, reason: 'loading' },
    bySession: {},
    generation: 0,

    refreshCapability: async () => {
      try {
        const directEdit = await directEditCapability()
        set({ capability: { known: true, directEdit } })
      } catch (e) {
        // An unanswered question is not a yes. `effectiveAccess` reads this as
        // `capability-unknown` and keeps the session in Review only.
        set({
          capability: { known: false, reason: 'failed', message: messageOf(e) },
        })
      }
    },

    authorize: async (sessionId, folder, dataFolder) => {
      const generation = get().generation + 1
      set({ generation })
      let grantId: string
      try {
        grantId = await directEditAuthorize(dataFolder, sessionId, folder)
      } catch (e) {
        return { ok: false, reason: messageOf(e) }
      }

      // The reply outlived the question. Something else has been asked since —
      // a different folder, a different session, or a cancellation — so this
      // grant is authority nobody asked for. Hand it back rather than holding
      // it: a grant the UI has forgotten is exactly the hidden authority this
      // store exists to prevent.
      if (get().generation !== generation) {
        void directEditRevoke(grantId).catch(() => {})
        return { ok: false, reason: 'superseded' }
      }

      const grant: LiveGrant = { sessionId, folder, grantId }
      set((s) => ({ bySession: { ...s.bySession, [sessionId]: grant } }))
      return { ok: true, grant }
    },

    revokeSession: async (sessionId) => {
      const grant = get().bySession[sessionId]
      // Superseding first: a reply still in flight must not install itself
      // after this.
      set((s) => ({ generation: s.generation + 1 }))
      if (!grant) {
        // Nothing local, but the backend may still hold something for this
        // session — a reply that raced us. Asking is idempotent.
        try {
          await directEditRevokeSession(sessionId)
          return true
        } catch {
          return false
        }
      }

      let revoked = false
      try {
        await directEditRevoke(grant.grantId)
        revoked = true
      } catch {
        revoked = false
      }
      // Local state is cleared either way: continuing to show a grant the user
      // asked to remove would be worse than a stale one on the backend, which
      // resolves for nothing once the session moves on. The caller is told, so
      // it can say what actually happened rather than claiming success.
      set((s) => {
        const next = { ...s.bySession }
        delete next[sessionId]
        return { bySession: next }
      })
      return revoked
    },

    grantFor: (sessionId) =>
      sessionId ? get().bySession[sessionId] : undefined,

    forget: (sessionId) =>
      set((s) => {
        if (!(sessionId in s.bySession)) return s
        const next = { ...s.bySession }
        delete next[sessionId]
        return { bySession: next, generation: s.generation + 1 }
      }),
  })
)
