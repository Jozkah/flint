/** Content-derived React keys for read-only lists; repeats get an occurrence suffix. */
export function stableKeys(items: readonly string[]): string[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const n = seen.get(item) ?? 0
    seen.set(item, n + 1)
    return n === 0 ? item : `${item}\u0000${n}`
  })
}
