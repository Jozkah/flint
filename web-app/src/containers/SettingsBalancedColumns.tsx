import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

/** Space between two groups, in px (the page's `gap-4`). */
const GAP = 16

/**
 * Put each group, in source order, into whichever of two columns is shorter so
 * far. Returns the column (0 or 1) of every group and the row offset where it
 * starts in that column. Whole groups only, so the two columns end within one
 * group's height of each other.
 */
export function packColumns(heights: readonly number[]) {
  // A group that renders nothing takes no row and no gap.
  const spans = heights.map((h) => (h > 0 ? Math.ceil(h) + GAP : 1))
  const greedy: (0 | 1)[] = []
  {
    const ends = [0, 0]
    for (const s of spans) {
      const c = ends[1] < ends[0] ? 1 : 0
      greedy.push(c)
      ends[c] += s
    }
  }
  let cols = greedy
  // A pure shorter-column-next pass can leave a tall gap when a big group
  // comes early, so for a page's few groups try every split and take the most
  // level one, preferring (within a small tolerance) the split closest to the
  // greedy, row-by-row reading order.
  if (spans.length > 2 && spans.length <= 14) {
    const total = spans.reduce((a, b) => a + b, 0)
    const diffOf = (mask: number) => {
      let one = 0
      spans.forEach((s, i) => {
        if (mask & (1 << i)) one += s
      })
      return Math.abs(total - 2 * one)
    }
    const masks = 1 << (spans.length - 1) // group 0 stays in column 0
    let best = Infinity
    for (let m = 0; m < masks; m++) best = Math.min(best, diffOf(m << 1))
    let pick = -1
    let pickDist = Infinity
    for (let m = 0; m < masks; m++) {
      const mask = m << 1
      if (diffOf(mask) > best + GAP * 2) continue
      let dist = 0
      for (let i = 0; i < spans.length; i++)
        if (((mask >> i) & 1) !== greedy[i]) dist++
      if (dist < pickDist || (dist === pickDist && diffOf(mask) < diffOf(pick))) {
        pick = mask
        pickDist = dist
      }
    }
    cols = spans.map((_, i) => (((pick >> i) & 1) as 0 | 1))
  }
  const ends = [0, 0]
  return spans.map((span, i) => {
    const col = cols[i]
    const top = ends[col]
    ends[col] = top + span
    return { col, top, span }
  })
}

/**
 * Settings groups in two columns balanced by height, masonry style. Every
 * group stays mounted in one place in the DOM (moving a group between two
 * parents would remount it and lose its state); a 1px-row grid places each one
 * from its measured height, so no group is padded and no column leaves a tall
 * blank stretch under it. A ResizeObserver re-packs when a group grows or
 * shrinks, and the first pack runs before paint, so nothing jumps.
 *
 * DOM order, and so tab order, is the source order. Because each group goes
 * to the shorter column in that order, the visual order follows it closely,
 * reading across the two columns row by row. One column on narrow windows,
 * in source order.
 */
export function SettingsBalancedColumns({ children }: { children: ReactNode[] }) {
  const refs = useRef<(HTMLDivElement | null)[]>([])
  const [placed, setPlaced] = useState<ReturnType<typeof packColumns>>([])

  const pack = useCallback(() => {
    const heights = refs.current.map((el) => el?.getBoundingClientRect().height ?? 0)
    const next = packColumns(heights)
    setPlaced((prev) =>
      prev.length === next.length &&
      prev.every((p, i) => p.col === next[i].col && p.top === next[i].top && p.span === next[i].span)
        ? prev
        : next
    )
  }, [])

  const count = children.length
  useLayoutEffect(() => {
    pack()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(pack)
    for (const el of refs.current) if (el) ro.observe(el)
    return () => ro.disconnect()
  }, [pack, count])

  return (
    <div className="flex min-w-0 flex-col gap-4 @min-[44rem]:-mb-4 @min-[44rem]:grid @min-[44rem]:auto-rows-[1px] @min-[44rem]:grid-cols-2 @min-[44rem]:gap-x-4 @min-[44rem]:gap-y-0">
      {children.map((child, i) => {
        const p = placed[i]
        return (
          <div
            key={i}
            ref={(el) => {
              refs.current[i] = el
            }}
            data-col={p?.col}
            className="min-w-0 @min-[44rem]:self-start @min-[44rem]:[grid-column:var(--col)] @min-[44rem]:[grid-row:var(--row)]"
            style={
              p
                ? ({
                    '--col': p.col + 1,
                    '--row': `${p.top + 1} / span ${p.span}`,
                  } as CSSProperties)
                : undefined
            }
          >
            {child}
          </div>
        )
      })}
    </div>
  )
}
