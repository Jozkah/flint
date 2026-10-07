/** Milliseconds between the words of BlurWords. */
export const BLUR_WORD_STEP = 260

/** When the last word of `text` starts to appear: time follow-ups from here. */
export function blurWordsDelay(text: string): number {
  return text.split(' ').filter(Boolean).length * BLUR_WORD_STEP
}
