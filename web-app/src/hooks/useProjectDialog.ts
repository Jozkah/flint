import { create } from 'zustand'

/** What the dialog calls the thing it creates. */
export type ProjectDialogNoun = 'project' | 'group'

type ProjectDialogState = {
  open: boolean
  noun: ProjectDialogNoun
  /** "New project" (palette, shortcut) opens it as a project; the sidebar's "New group" passes 'group'. */
  setOpen: (value: boolean, noun?: ProjectDialogNoun) => void
}

export const useProjectDialog = create<ProjectDialogState>()((set) => ({
  open: false,
  noun: 'project',
  setOpen: (value, noun) =>
    set(value ? { open: true, noun: noun ?? 'project' } : { open: false }),
}))
