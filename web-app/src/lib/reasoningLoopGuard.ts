/** Detect a model stuck repeating the same reasoning, independent of stream chunks. */
export class ReasoningLoopGuard {
  private pending = ''
  private tokens: string[] = []

  add(delta: string): boolean {
    const joined = this.pending + delta
    const words = joined.split(/\s+/)
    this.pending = words.pop() ?? ''
    this.tokens.push(...words.filter(Boolean))
    if (this.tokens.length > 256) this.tokens.splice(0, this.tokens.length - 256)

    // Four identical 16-token blocks are long enough to distinguish a loop
    // from ordinary repeated references, lists, and short quoted text.
    const size = 16
    const count = this.tokens.length
    if (count < size * 4) return false
    const tail = this.tokens.slice(count - size).join(' ')
    for (let repeat = 2; repeat <= 4; repeat++) {
      if (this.tokens.slice(count - size * repeat, count - size * (repeat - 1)).join(' ') !== tail) {
        return false
      }
    }
    return true
  }
}
