/**
 * User-chosen keyboard shortcuts. AH-207.
 *
 * Only overrides are stored; an action with no override uses its default from
 * `PlatformShortcuts`, so a default that changes in a later release reaches
 * everyone who never customised that action. Persisted through the backend
 * settings store like other settings, so a binding survives a restart.
 *
 * A binding that collides with another action's is refused, naming that
 * action. Two actions on one key would each fire or neither would, depending
 * on listener order, and the user would have no way to tell which.
 */
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { backendStorage } from '@/lib/backendStorage'
import {
  PlatformShortcuts,
  ShortcutAction,
  isMac,
  type ShortcutSpec,
} from '@/lib/shortcuts'

/** A binding as it matches a key event: resolved for this platform. */
export type Chord = {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/** Resolve a spec's platform-meta flag into concrete modifiers. */
export function chordOf(spec: ShortcutSpec): Chord {
  const platformMeta = spec.usePlatformMetaKey === true
  return {
    key: spec.key.toLowerCase(),
    ctrl: (spec.ctrlKey ?? false) || (platformMeta && !isMac),
    meta: (spec.metaKey ?? false) || (platformMeta && isMac),
    alt: spec.altKey ?? false,
    shift: spec.shiftKey ?? false,
  }
}

export const sameChord = (a: Chord, b: Chord): boolean =>
  a.key === b.key &&
  a.ctrl === b.ctrl &&
  a.meta === b.meta &&
  a.alt === b.alt &&
  a.shift === b.shift

/** A key event as a spec, for recording a new binding. */
export function specFromEvent(e: {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  shiftKey: boolean
}): ShortcutSpec | null {
  // A modifier on its own is not a binding yet.
  if (['control', 'meta', 'alt', 'shift', 'os'].includes(e.key.toLowerCase())) {
    return null
  }
  // Without a modifier every keystroke typed into the composer would fire it.
  if (!e.ctrlKey && !e.metaKey && !e.altKey) return null
  const platformMeta = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    ...(platformMeta
      ? { usePlatformMetaKey: true }
      : { ctrlKey: e.ctrlKey, metaKey: e.metaKey }),
    ...(e.altKey ? { altKey: true } : {}),
    ...(e.shiftKey ? { shiftKey: true } : {}),
  }
}

/** Actions a user may rebind. Zoom keeps its alias keys and stays fixed. */
export const REBINDABLE: ShortcutAction[] = [
  ShortcutAction.NEW_CHAT,
  ShortcutAction.NEW_PROJECT,
  ShortcutAction.TOGGLE_SIDEBAR,
  ShortcutAction.GO_TO_SETTINGS,
  ShortcutAction.SEARCH,
  ShortcutAction.SWITCH_ASSISTANT,
  ShortcutAction.COMMAND_PALETTE,
  ShortcutAction.SPLIT_VIEW,
]

export type BindResult =
  | { ok: true }
  | { ok: false; reason: 'conflict'; with: ShortcutAction }
  | { ok: false; reason: 'not-rebindable' }

type KeybindingsState = {
  overrides: Partial<Record<ShortcutAction, ShortcutSpec>>
  /**
   * A new binding is being recorded. Every app shortcut stands down while it
   * is, so pressing a chord that is already taken is reported as taken instead
   * of running its command. Not persisted.
   */
  recording: boolean
  setRecording: (recording: boolean) => void
  /** The binding in force for an action. */
  specFor: (action: ShortcutAction) => ShortcutSpec
  bind: (action: ShortcutAction, spec: ShortcutSpec) => BindResult
  reset: (action: ShortcutAction) => void
  resetAll: () => void
}

export const useKeybindings = create<KeybindingsState>()(
  persist(
    (set, get) => ({
      overrides: {},
      recording: false,
      setRecording: (recording) => set({ recording }),
      specFor: (action) => get().overrides[action] ?? PlatformShortcuts[action],
      bind: (action, spec) => {
        if (!REBINDABLE.includes(action)) {
          return { ok: false, reason: 'not-rebindable' }
        }
        const wanted = chordOf(spec)
        // Every action counts, rebindable or not: taking zoom's key would
        // leave zoom broken with no way for the user to see why.
        for (const other of Object.values(ShortcutAction)) {
          if (other === action) continue
          const specs = [get().specFor(other)]
          const aliases = PlatformShortcuts[other].aliasKeys ?? []
          for (const alias of aliases) specs.push({ ...specs[0], key: alias })
          if (specs.some((s) => sameChord(chordOf(s), wanted))) {
            return { ok: false, reason: 'conflict', with: other }
          }
        }
        set((s) => ({ overrides: { ...s.overrides, [action]: spec } }))
        return { ok: true }
      },
      reset: (action) =>
        set((s) => {
          const next = { ...s.overrides }
          delete next[action]
          return { overrides: next }
        }),
      resetAll: () => set({ overrides: {} }),
    }),
    {
      name: localStorageKey.keybindings,
      storage: createJSONStorage(() => backendStorage),
      partialize: (s) => ({ overrides: s.overrides }),
      skipHydration: true,
    }
  )
)
