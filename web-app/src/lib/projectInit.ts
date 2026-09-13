/**
 * Drafts of a project's starting `JAN.md`, kept until they are accepted or
 * discarded. AH-209.
 *
 * A survey produces a draft; the user edits it; nothing reaches the folder
 * until they accept it. The draft in between is theirs, so it is kept per
 * folder through the backend settings store and survives a restart: closing
 * the dialog, or the app, does not throw away an edit.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import { folderKey } from '@/lib/referenceAliases'

export type ProjectInitDraft = {
  content: string
  /** What the survey could not read, in its own words. */
  notRead: string[]
  /** Files whose content the survey read. */
  read: string[]
  surveyedAt: number
}

type DraftState = {
  drafts: Record<string, ProjectInitDraft>
  draftFor: (root: string | null | undefined) => ProjectInitDraft | null
  setDraft: (root: string, draft: ProjectInitDraft) => void
  editDraft: (root: string, content: string) => void
  clear: (root: string) => void
}

export const useProjectInitDrafts = create<DraftState>()(
  persist(
    (set, get) => ({
      drafts: {},
      draftFor: (root) =>
        root ? (get().drafts[folderKey(root)] ?? null) : null,
      setDraft: (root, draft) =>
        set((s) => ({ drafts: { ...s.drafts, [folderKey(root)]: draft } })),
      editDraft: (root, content) =>
        set((s) => {
          const key = folderKey(root)
          const existing = s.drafts[key]
          if (!existing) return s
          return { drafts: { ...s.drafts, [key]: { ...existing, content } } }
        }),
      clear: (root) =>
        set((s) => {
          const next = { ...s.drafts }
          delete next[folderKey(root)]
          return { drafts: next }
        }),
    }),
    {
      name: localStorageKey.projectInitDrafts,
      storage: createJSONStorage(() => backendStorage),
      partialize: (s) => ({ drafts: s.drafts }),
      skipHydration: true,
    }
  )
)
