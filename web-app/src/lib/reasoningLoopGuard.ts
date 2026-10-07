/** Longest repeating unit looked for, in whitespace-separated tokens. */
const MAX_PERIOD = 64
/** The history kept: room for the longest unit repeated four times. */
const WINDOW = MAX_PERIOD * 4
/** A repeat shorter than this many tokens in total is never called a loop. */
const MIN_COVERED = 48
/** A unit must come round at least this often. */
const MIN_REPEATS = 4

/**
 * Detect a model stuck repeating the same reasoning, independent of stream
 * chunks. The repeating unit can be any length: a whole paragraph, or three
 * numbers over and over (`5228, 12804, 17892,` repeated through a process
 * list), which a fixed-size block check never saw.
 */
export class ReasoningLoopGuard {
  private pending = ''
  private tokens: string[] = []

  add(delta: string): boolean {
    const joined = this.pending + delta
    const words = joined.split(/\s+/)
    this.pending = words.pop() ?? ''
    this.tokens.push(...words.filter(Boolean))
    if (this.tokens.length > WINDOW) this.tokens.splice(0, this.tokens.length - WINDOW)
    return this.looping()
  }

  private looping(): boolean {
    const t = this.tokens
    const count = t.length
    for (let period = 1; period <= MAX_PERIOD; period++) {
      // Enough repeats to cover MIN_COVERED tokens (a short unit needs more
      // rounds than a long one), and never fewer than MIN_REPEATS.
      const repeats = Math.max(MIN_REPEATS, Math.ceil(MIN_COVERED / period))
      const span = period * repeats
      if (span > count) continue
      let same = true
      for (let i = count - span + period; i < count; i++) {
        if (t[i] !== t[i - period]) {
          same = false
          break
        }
      }
      if (same) return true
    }
    return false
  }
}
