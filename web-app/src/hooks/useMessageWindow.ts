import { useCallback, useState } from 'react'

/** Messages rendered when a chat opens (the newest ones). */
export const MESSAGE_WINDOW_INITIAL = 10
/** Messages added each time the reader reaches the top. */
export const MESSAGE_WINDOW_STEP = 12

type WindowState = { key: string; shown: number; count: number }

/**
 * Render only the tail of a long transcript. A 300-message chat with code and
 * tables is ~100k DOM nodes; every keystroke, token and style recalculation
 * pays for all of them. The window keeps the newest messages mounted and grows
 * upwards on demand (scrolling to the top, find-in-chat jumping to an older
 * message). Messages that arrive while the chat is open widen the window
 * instead of pushing older rendered ones out, so nothing above the reader moves.
 */
export function useMessageWindow(count: number, resetKey: string) {
  const [state, setState] = useState<WindowState>(() => ({
    key: resetKey,
    shown: MESSAGE_WINDOW_INITIAL,
    count,
  }))

  let current = state
  if (state.key !== resetKey) {
    current = { key: resetKey, shown: MESSAGE_WINDOW_INITIAL, count }
    setState(current)
  } else if (state.count !== count) {
    // The first load (0 -> n) keeps the initial window; later growth while the
    // chat is open keeps every message already rendered on screen.
    const grown = state.count > 0 && count > state.count
    current = {
      key: resetKey,
      shown: grown ? state.shown + (count - state.count) : state.shown,
      count,
    }
    setState(current)
  }

  const start = Math.max(0, count - current.shown)

  const loadEarlier = useCallback(
    () =>
      setState((s) =>
        s.shown >= s.count ? s : { ...s, shown: s.shown + MESSAGE_WINDOW_STEP }
      ),
    []
  )

  /** Make sure the message at `index` is mounted (plus a little context). */
  const reveal = useCallback(
    (index: number) =>
      setState((s) => {
        const need = s.count - Math.max(0, index - 2)
        return need > s.shown ? { ...s, shown: need } : s
      }),
    []
  )

  return { start, loadEarlier, reveal, hasEarlier: start > 0 }
}
