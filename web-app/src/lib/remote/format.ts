/** mm:ss until `deadline`, never negative. */
export function countdown(deadline: number, now: number): string {
  const s = Math.max(0, Math.ceil((deadline - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
