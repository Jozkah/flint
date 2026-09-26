/**
 * Width rules for Cowork's Output rail.
 *
 * The rail is wide enough to read whole source files: it may take up to
 * `PANEL_WIDE_RATIO` of the space it shares with the conversation, but never
 * so much that the conversation drops under `CONVERSATION_MIN_W`. Expanding
 * goes further -- everything except the conversation's minimum.
 *
 * Pure functions, so the clamp is tested without a layout engine.
 */

export const PANEL_MIN_W = 240
export const PANEL_DEFAULT_W = 430
/** The share of the available width a dragged rail may take. */
export const PANEL_WIDE_RATIO = 0.7
/** What the conversation keeps however wide the rail gets. */
export const CONVERSATION_MIN_W = 360
/** Where the chosen width is remembered, per OS user profile. */
export const WIDTH_STORAGE_KEY = 'flint.cowork.outputRailWidth'

/**
 * The space the rail and the conversation share. A container that has not
 * been laid out yet (0) reads as the window, so the first render is not
 * clamped to the minimum.
 */
export function availableWidth(container: number | null | undefined): number {
  if (container && container > 0) return container
  if (typeof window !== 'undefined' && window.innerWidth > 0) {
    return window.innerWidth
  }
  return PANEL_DEFAULT_W + CONVERSATION_MIN_W
}

/** The widest a dragged rail may be in `container` pixels. */
export function maxPanelWidth(container: number | null | undefined): number {
  const space = availableWidth(container)
  return Math.max(
    PANEL_MIN_W,
    Math.min(Math.round(space * PANEL_WIDE_RATIO), space - CONVERSATION_MIN_W)
  )
}

/** Hold a requested width between the minimum and the container's maximum. */
export function clampPanelWidth(
  width: number,
  container: number | null | undefined
): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_W
  return Math.round(
    Math.min(maxPanelWidth(container), Math.max(PANEL_MIN_W, width))
  )
}

/** The expanded rail: all of the space except the conversation's minimum. */
export function expandedPanelWidth(
  container: number | null | undefined
): number {
  return Math.max(PANEL_MIN_W, availableWidth(container) - CONVERSATION_MIN_W)
}

/**
 * Double-clicking the resize handle toggles between the default width and the
 * widest dragged width. Anything already wider than the default goes back to
 * the default; anything at or under it goes wide.
 */
export function toggledPanelWidth(
  current: number,
  container: number | null | undefined
): number {
  const wide = maxPanelWidth(container)
  return current > PANEL_DEFAULT_W + 8 ? PANEL_DEFAULT_W : wide
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

const defaultStore = (): KeyValueStore | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** The remembered width, or null when none was stored or it is unusable. */
export function readStoredWidth(
  store: KeyValueStore | null = defaultStore()
): number | null {
  try {
    const raw = store?.getItem(WIDTH_STORAGE_KEY)
    if (raw == null) return null
    const value = Number(raw)
    return Number.isFinite(value) && value >= PANEL_MIN_W ? value : null
  } catch {
    return null
  }
}

export function writeStoredWidth(
  width: number,
  store: KeyValueStore | null = defaultStore()
): void {
  try {
    store?.setItem(WIDTH_STORAGE_KEY, String(Math.round(width)))
  } catch {
    // Storage full or blocked: the width still applies for this run.
  }
}
