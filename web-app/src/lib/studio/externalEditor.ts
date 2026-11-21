import { localStorageKey } from '@/constants/localStorage'
import { studioApi, type GalleryItem } from '@/lib/studio/studio'

/**
 * The app a Studio picture opens in for editing. Flint ships no editor: the
 * person points at one (G'MIC-Qt, Krita, GIMP, ...). The program is checked and
 * started by the backend without a shell; this only remembers the choice.
 */
export type EditorPreset = 'gmic' | 'custom'

export type ExternalEditor = {
  preset: EditorPreset
  /** Full path of the program. */
  program: string
  /** Arguments, with `{file}` for the picture; the picture is appended without it. */
  args: string
}

export const EMPTY_EDITOR: ExternalEditor = { preset: 'gmic', program: '', args: '' }

/** G'MIC-Qt takes the image to open as its argument: the default is enough. */
export const PRESET_ARGS: Record<EditorPreset, string> = { gmic: '', custom: '' }

export const isEditorConfigured = (editor: ExternalEditor): boolean =>
  editor.program.trim() !== ''

const MAX = 2000

export function readEditor(): ExternalEditor {
  try {
    const raw = globalThis.localStorage?.getItem(localStorageKey.studioExternalEditor)
    if (!raw) return EMPTY_EDITOR
    const v = JSON.parse(raw) as Partial<ExternalEditor>
    return {
      preset: v.preset === 'custom' ? 'custom' : 'gmic',
      program: typeof v.program === 'string' ? v.program.slice(0, MAX) : '',
      args: typeof v.args === 'string' ? v.args.slice(0, MAX) : '',
    }
  } catch {
    return EMPTY_EDITOR
  }
}

const listeners = new Set<() => void>()

export function subscribeEditor(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function writeEditor(editor: ExternalEditor): void {
  try {
    globalThis.localStorage?.setItem(
      localStorageKey.studioExternalEditor,
      JSON.stringify(editor)
    )
  } catch {
    // Storage blocked: the choice lasts until the dialog closes only.
  }
  listeners.forEach((l) => l())
}

/** Open one gallery picture in the configured editor. Rejects with the reason. */
export function openInEditor(item: GalleryItem, editor: ExternalEditor): Promise<void> {
  return studioApi.openExternal(item.kind, item.id, editor.program, editor.args)
}
