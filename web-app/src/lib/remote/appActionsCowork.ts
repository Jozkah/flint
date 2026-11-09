// `RemoteActions` for Cowork sessions: creating one, and its mode, model and access.

import { useCoworkSessions } from '@/hooks/useCoworkSessions'
import { useCoworkRun } from '@/hooks/useCoworkRun'
import { useDirectEditGrants } from '@/hooks/useDirectEditGrants'
import type { RemoteActions } from './actions'

export function coworkActions(): Pick<
  RemoteActions,
  | 'coworkExists'
  | 'coworkBusy'
  | 'knownFolders'
  | 'createCowork'
  | 'setCoworkMode'
  | 'setCoworkModel'
  | 'coworkAccess'
  | 'setCoworkReviewOnly'
> {
  return {
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
  }
}
