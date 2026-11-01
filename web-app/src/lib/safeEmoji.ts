// Safe-emoji mode: the desktop shell sets this flag (localStorage) after the
// web process crashed repeatedly. Some WebKitGTK/Skia builds abort while
// painting COLRv1 colour glyphs (Noto Color Emoji and friends), so the mode
// keeps colour emoji fonts out of the text fallback chain (see font.css).
export const SAFE_EMOJI_KEY = 'flint-safe-emoji'
export const SAFE_EMOJI_CLASS = 'safe-emoji'

export function applySafeEmojiMode(
  storage: Pick<Storage, 'getItem'> | undefined,
  root: Pick<HTMLElement, 'classList'>
): boolean {
  let on = false
  try {
    on = storage?.getItem(SAFE_EMOJI_KEY) === '1'
  } catch {
    on = false
  }
  if (on) root.classList.add(SAFE_EMOJI_CLASS)
  return on
}
