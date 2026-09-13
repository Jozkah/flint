import { describe, it, expect, vi, beforeEach } from 'vitest'

// Persisted through the backend settings store; the persist layer is replaced
// by one that records what would be written, so "survives a restart" can be
// checked as "the override is what gets persisted".
const written: Record<string, string> = {}
vi.mock('@/lib/backendStorage', () => ({
  backendStorage: {
    getItem: (k: string) => written[k] ?? null,
    setItem: (k: string, v: string) => {
      written[k] = v
    },
    removeItem: (k: string) => {
      delete written[k]
    },
  },
}))

import {
  useKeybindings,
  specFromEvent,
  chordOf,
  sameChord,
} from '../useKeybindings'
import { PlatformShortcuts, ShortcutAction } from '@/lib/shortcuts'

beforeEach(() => {
  useKeybindings.getState().resetAll()
})

describe('keybindings', () => {
  it('uses the platform default until the user sets one', () => {
    expect(useKeybindings.getState().specFor(ShortcutAction.SEARCH)).toEqual(
      PlatformShortcuts[ShortcutAction.SEARCH]
    )
  })

  it('binds a free chord and uses it from then on', () => {
    const spec = { key: 'y', usePlatformMetaKey: true, altKey: true }
    expect(useKeybindings.getState().bind(ShortcutAction.SEARCH, spec)).toEqual(
      {
        ok: true,
      }
    )
    expect(useKeybindings.getState().specFor(ShortcutAction.SEARCH)).toEqual(
      spec
    )
  })

  /// The acceptance criterion: a collision is refused, naming the command it
  /// collides with, and nothing changes.
  it('refuses a chord another command already uses, and names that command', () => {
    const taken = PlatformShortcuts[ShortcutAction.NEW_CHAT]
    expect(
      useKeybindings.getState().bind(ShortcutAction.SEARCH, taken)
    ).toEqual({
      ok: false,
      reason: 'conflict',
      with: ShortcutAction.NEW_CHAT,
    })
    expect(useKeybindings.getState().specFor(ShortcutAction.SEARCH)).toEqual(
      PlatformShortcuts[ShortcutAction.SEARCH]
    )
  })

  it("counts a fixed command's alias keys as taken", () => {
    const zoomAlias = { key: '=', usePlatformMetaKey: true }
    expect(
      useKeybindings.getState().bind(ShortcutAction.SEARCH, zoomAlias)
    ).toMatchObject({
      ok: false,
      with: ShortcutAction.ZOOM_IN,
    })
  })

  it('counts a rebound command by its new chord, and frees its old one', () => {
    const moved = { key: 'u', usePlatformMetaKey: true, altKey: true }
    useKeybindings.getState().bind(ShortcutAction.NEW_CHAT, moved)
    // The old New Chat chord is free now.
    expect(
      useKeybindings
        .getState()
        .bind(ShortcutAction.SEARCH, PlatformShortcuts[ShortcutAction.NEW_CHAT])
    ).toEqual({ ok: true })
    // And the new one is taken.
    expect(
      useKeybindings.getState().bind(ShortcutAction.SWITCH_ASSISTANT, moved)
    ).toMatchObject({
      ok: false,
      with: ShortcutAction.NEW_CHAT,
    })
  })

  it('does not let zoom be rebound', () => {
    expect(
      useKeybindings
        .getState()
        .bind(ShortcutAction.ZOOM_IN, { key: 'q', usePlatformMetaKey: true })
    ).toEqual({ ok: false, reason: 'not-rebindable' })
  })

  it('persists only the overrides, so a restart restores them', () => {
    const spec = { key: 'y', usePlatformMetaKey: true, altKey: true }
    useKeybindings.getState().bind(ShortcutAction.SEARCH, spec)
    const persisted = JSON.parse(written['keybindings'])
    expect(persisted.state).toEqual({
      overrides: { [ShortcutAction.SEARCH]: spec },
    })
  })

  it('restores a persisted binding when the store rehydrates, as it does at startup', async () => {
    const spec = { key: 'y', usePlatformMetaKey: true, altKey: true }
    // Cleared first: every set() is persisted, so clearing after seeding the
    // store would overwrite the very value the restart should find.
    useKeybindings.setState({ overrides: {} })
    written['keybindings'] = JSON.stringify({
      state: { overrides: { [ShortcutAction.COMMAND_PALETTE]: spec } },
      version: 0,
    })
    await useKeybindings.persist.rehydrate()
    expect(
      useKeybindings.getState().specFor(ShortcutAction.COMMAND_PALETTE)
    ).toEqual(spec)
    // Recording state is never persisted, so a restart cannot come back mid-recording.
    expect(useKeybindings.getState().recording).toBe(false)
  })

  it('reset puts the default back', () => {
    useKeybindings.getState().bind(ShortcutAction.SEARCH, {
      key: 'y',
      usePlatformMetaKey: true,
      altKey: true,
    })
    useKeybindings.getState().reset(ShortcutAction.SEARCH)
    expect(useKeybindings.getState().specFor(ShortcutAction.SEARCH)).toEqual(
      PlatformShortcuts[ShortcutAction.SEARCH]
    )
  })
})

describe('recording a chord', () => {
  const ev = (over: Partial<KeyboardEventInit & { key: string }>) => ({
    key: 'k',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  })

  it('ignores a modifier pressed on its own', () => {
    expect(specFromEvent(ev({ key: 'Control', ctrlKey: true }))).toBeNull()
  })

  it('refuses a bare key, which typing would trigger', () => {
    expect(specFromEvent(ev({ key: 'k' }))).toBeNull()
    expect(specFromEvent(ev({ key: 'K', shiftKey: true }))).toBeNull()
  })

  it('records the chord that was pressed', () => {
    const spec = specFromEvent(
      ev({ key: 'K', ctrlKey: true, metaKey: true, shiftKey: true })
    )
    expect(spec).not.toBeNull()
    const pressed = chordOf(spec!)
    expect(pressed.key).toBe('k')
    expect(pressed.shift).toBe(true)
    expect(sameChord(pressed, chordOf(spec!))).toBe(true)
  })
})
