/**
 * "Automatically save local memories" — the toggle that could not be toggled.
 *
 * Two defects, in series.
 *
 * The page built its `MemoryLocation` from `window.core?.api?.dataFolder`,
 * which nothing in the application defines. It was the only reference to that
 * path anywhere. So `dataFolder` was `''`, the backend's `settings_root()`
 * returned `None`, and *every* command on the page rejected with
 * `{ message: "no data folder to store settings in" }`. The toggle was just
 * the first one anyone pressed.
 *
 * The rejection is a plain object, because `AgentToolsError` is a struct.
 * `String(error)` on it yields `[object Object]`, which is the "object" in
 * "Could not change that setting / object".
 *
 * These cover the boundary shape and the toggle's lifecycle. The Rust half --
 * that `settings_root()` refuses an empty folder, and that `Settings`
 * round-trips as camelCase -- is asserted in the plugin's own tests.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorText } from '@/lib/errorText'

const memorySettingsUpdate = vi.fn()
const memorySettingsGet = vi.fn()

const settings = (automaticallySave: boolean) => ({
  automaticallySave,
  schemaVersion: 1,
})

/** How Tauri rejects when the Rust side returns `AgentToolsError`. */
const rustRejection = (message: string) => ({ message })

/**
 * The toggle's lifecycle, isolated from React so the ordering rules can be
 * asserted directly: optimistic move, authoritative adoption, rollback, and
 * one write at a time.
 */
class Toggle {
  autoSave = false
  pending = false
  toasted: { title: string; description: string }[] = []
  private saving = false

  constructor(private location: { dataFolder: string } | null) {}

  async set(next: boolean): Promise<void> {
    if (!this.location || this.saving) return
    const previous = this.autoSave
    this.saving = true
    this.pending = true
    this.autoSave = next
    try {
      const saved = await memorySettingsUpdate(this.location, next)
      this.autoSave = saved.automaticallySave
    } catch (error) {
      this.autoSave = previous
      this.toasted.push({
        title: 'Memory settings could not be saved',
        description: errorText(error),
      })
    } finally {
      this.saving = false
      this.pending = false
    }
  }
}

const at = (folder: string | null) =>
  new Toggle(folder == null ? null : { dataFolder: folder })

beforeEach(() => {
  memorySettingsUpdate.mockReset()
  memorySettingsGet.mockReset()
})

describe('the location the page sends', () => {
  it('is null until the data folder is known', () => {
    // The regression: `''` reached the backend and every command rejected.
    const t = at(null)
    expect(t.autoSave).toBe(false)
  })

  it('sends nothing while the data folder is unknown', async () => {
    await at(null).set(true)
    expect(memorySettingsUpdate).not.toHaveBeenCalled()
  })

  it('sends the resolved folder once it is known', async () => {
    memorySettingsUpdate.mockResolvedValue(settings(true))
    await at('/data').set(true)
    expect(memorySettingsUpdate).toHaveBeenCalledWith(
      { dataFolder: '/data' },
      true
    )
  })
})

describe('toggling', () => {
  it('turns on and adopts what the backend stored', async () => {
    memorySettingsUpdate.mockResolvedValue(settings(true))
    const t = at('/data')
    await t.set(true)
    expect(t.autoSave).toBe(true)
  })

  it('turns off again', async () => {
    memorySettingsUpdate.mockResolvedValue(settings(false))
    const t = at('/data')
    t.autoSave = true
    await t.set(false)
    expect(t.autoSave).toBe(false)
  })

  /// The backend is authoritative: if it stored something else, the switch
  /// shows what was stored, not what was asked for.
  it('adopts the stored value even when it differs from the request', async () => {
    memorySettingsUpdate.mockResolvedValue(settings(false))
    const t = at('/data')
    await t.set(true)
    expect(t.autoSave).toBe(false)
  })

  it('rolls back when the write fails', async () => {
    memorySettingsUpdate.mockRejectedValue(rustRejection('disk is full'))
    const t = at('/data')
    await t.set(true)
    expect(t.autoSave).toBe(false)
  })

  it('leaves the switch alone when a rollback follows an enabled state', async () => {
    memorySettingsUpdate.mockRejectedValue(rustRejection('nope'))
    const t = at('/data')
    t.autoSave = true
    await t.set(false)
    expect(t.autoSave).toBe(true)
  })

  it('retries successfully after a failure', async () => {
    const t = at('/data')
    memorySettingsUpdate.mockRejectedValueOnce(rustRejection('transient'))
    await t.set(true)
    expect(t.autoSave).toBe(false)
    memorySettingsUpdate.mockResolvedValue(settings(true))
    await t.set(true)
    expect(t.autoSave).toBe(true)
  })

  /// Two overlapping writes could land in either order, settling the switch on
  /// the opposite of the last thing clicked.
  it('sends one write at a time', async () => {
    let release: (v: unknown) => void = () => {}
    memorySettingsUpdate.mockReturnValue(
      new Promise((r) => {
        release = r
      })
    )
    const t = at('/data')
    const first = t.set(true)
    await t.set(false)
    expect(memorySettingsUpdate).toHaveBeenCalledTimes(1)
    release(settings(true))
    await first
    expect(t.autoSave).toBe(true)
  })

  it('clears its pending state whichever way the write goes', async () => {
    memorySettingsUpdate.mockResolvedValue(settings(true))
    const t = at('/data')
    await t.set(true)
    expect(t.pending).toBe(false)

    memorySettingsUpdate.mockRejectedValue(rustRejection('x'))
    await t.set(false)
    expect(t.pending).toBe(false)
  })
})

describe('what the user is shown when it fails', () => {
  it('never renders object or [object Object]', async () => {
    memorySettingsUpdate.mockRejectedValue(
      rustRejection('no data folder to store settings in')
    )
    const t = at('/data')
    await t.set(true)
    const shown = t.toasted[0]
    expect(shown.description).not.toBe('object')
    expect(shown.description).not.toContain('[object Object]')
  })

  it('renders the reason the backend gave', async () => {
    memorySettingsUpdate.mockRejectedValue(
      rustRejection('no data folder to store settings in')
    )
    const t = at('/data')
    await t.set(true)
    expect(t.toasted[0].description).toContain('no data folder')
    expect(t.toasted[0].title).toBe('Memory settings could not be saved')
  })

  it.each([
    ['a Rust struct error', rustRejection('disk is full'), 'disk is full'],
    ['an Error', new Error('boom'), 'boom'],
    ['a bare string', 'plain failure', 'plain failure'],
  ])('normalises %s', async (_label, rejection, expected) => {
    memorySettingsUpdate.mockRejectedValue(rejection)
    const t = at('/data')
    await t.set(true)
    expect(t.toasted[0].description).toContain(expected)
  })

  /// `String({message})` is what produced the original report.
  it('improves on what String() would have shown', () => {
    const rejection = rustRejection('no data folder to store settings in')
    expect(String(rejection)).toBe('[object Object]')
    expect(errorText(rejection)).not.toBe('[object Object]')
  })
})
